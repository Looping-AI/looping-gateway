import type { PushNotificationConfig, Task } from "@a2a-js/sdk";
import type {
  PushNotificationSender,
  PushNotificationStore
} from "@a2a-js/sdk/server";
import { getAgent, type LocalAgentKind } from "@/db/models/agents";
import {
  getAgentTaskByToken,
  recordAgentTaskError
} from "@/db/models/agent-tasks";
import { deliverTaskToSlack, TaskDeliveryValidationError } from "./shared";

/** Reserved internal-only target; it is never fetched over HTTP. */
export const LOCAL_NOTIFICATION_URL = "https://local.a2a.invalid/notifications";

/** Total delivery attempts (1 initial + retries) before giving up. */
const DELIVERY_MAX_ATTEMPTS = 3;
/**
 * Backoff before retry attempts 2 and 3 (ms). Deliberately short — the whole
 * delivery rides the in-flight Durable Object request that produced the Task.
 */
const DELIVERY_BACKOFF_MS = [250, 1000];
/** Gateway-controlled backstop notice recorded when delivery gives up. */
const DELIVERY_FAILED_MESSAGE =
  "the local agent's reply could not be delivered";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Build the correlation config that the local A2A sender recognizes. */
export function localPushNotificationConfig(
  token: string
): PushNotificationConfig {
  return { url: LOCAL_NOTIFICATION_URL, token };
}

/**
 * Deliver a Task emitted by an in-repo built-in agent without crossing the
 * public HTTP/JWT trust boundary. The registry kind check prevents one local
 * Durable Object from impersonating another agent's pending task.
 */
export async function deliverLocalAgentTask(
  token: string,
  task: Task,
  expectedKind: LocalAgentKind
): Promise<void> {
  const row = await getAgentTaskByToken(token);
  if (!row) {
    // Expected when the token was already completed-and-swept; log so a genuinely
    // dropped reply isn't fully silent.
    console.debug("[local-notifications] no task row for token", {
      taskId: task.id
    });
    return;
  }
  if (row.status === "completed") return;

  const agent = await getAgent(row.agentName);
  if (!agent || agent.kind !== expectedKind) {
    throw new Error(
      "local task does not belong to the expected built-in agent"
    );
  }
  await deliverTaskToSlack(token, row, agent, task);
}

/**
 * Bridges A2A Task snapshots directly into the gateway's durable delivery
 * ledger. The SDK invokes `send` serially from its event processor, but the
 * explicit chain also preserves status-update order if an implementation ever
 * calls it concurrently.
 */
export class LocalPushNotificationSender implements PushNotificationSender {
  private deliveryChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly pushNotificationStore: PushNotificationStore,
    private readonly agentKind: LocalAgentKind
  ) {}

  send(task: Task): Promise<void> {
    const delivery = this.deliveryChain.then(() => this.deliver(task));
    // Keep later notifications deliverable after a failed Slack/API call.
    this.deliveryChain = delivery.catch(() => undefined);
    return delivery;
  }

  /**
   * Resolve once every queued delivery (including retries) has settled. The DO
   * registers this on `ctx.waitUntil` so the runtime keeps the object alive until
   * the SDK's fire-and-forget deliveries complete. Never rejects — `deliver`
   * catches and records every error path.
   */
  drain(): Promise<void> {
    return this.deliveryChain;
  }

  private async deliver(task: Task): Promise<void> {
    // The initial submitted Task establishes acceptance only. It must not be
    // treated as a user-visible progress update, even if it carries a message.
    if (task.status.state === "submitted") return;

    const configs = await this.pushNotificationStore.load(task.id);
    for (const config of configs) {
      if (config.url !== LOCAL_NOTIFICATION_URL || !config.token) continue;
      await this.deliverWithRetry(task, config.token);
    }
  }

  /**
   * Deliver one snapshot, retrying a transient Slack/API failure with backoff.
   * The old synchronous path posted local replies inside a durable workflow step
   * that retried; this restores that resilience. `deliverTaskToSlack` is
   * replay-safe (the message-id dedupe skips an already-posted update; the
   * terminal completion flip is idempotent), so a retry re-posts the terminal
   * reply a failed attempt left pending without double-posting a delivered one.
   * A malformed snapshot is deterministic and not retried. On exhaustion the
   * failure is recorded for the reaction backstop.
   */
  private async deliverWithRetry(task: Task, token: string): Promise<void> {
    for (let attempt = 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt++) {
      try {
        await deliverLocalAgentTask(token, task, this.agentKind);
        return;
      } catch (err) {
        if (err instanceof TaskDeliveryValidationError) {
          console.error("[local-notifications] malformed task snapshot", {
            agentKind: this.agentKind,
            taskId: task.id,
            err: err.message
          });
          await recordAgentTaskError(token, DELIVERY_FAILED_MESSAGE);
          return;
        }
        const lastAttempt = attempt === DELIVERY_MAX_ATTEMPTS;
        console.error("[local-notifications] task delivery failed", {
          agentKind: this.agentKind,
          taskId: task.id,
          attempt,
          lastAttempt,
          err: err instanceof Error ? err.message : String(err)
        });
        if (lastAttempt) {
          await recordAgentTaskError(token, DELIVERY_FAILED_MESSAGE);
          return;
        }
        await sleep(DELIVERY_BACKOFF_MS[attempt - 1]);
      }
    }
  }
}
