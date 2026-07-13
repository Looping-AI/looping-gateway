import type { PushNotificationConfig, Task } from "@a2a-js/sdk";
import type {
  PushNotificationSender,
  PushNotificationStore
} from "@a2a-js/sdk/server";
import { getAgent, type AgentKind } from "@/db/models/agents";
import {
  getAgentTaskByToken,
  recordAgentTaskError
} from "@/db/models/agent-tasks";
import { deliverTaskToSlack } from "./shared";

/** Reserved internal-only target; it is never fetched over HTTP. */
export const LOCAL_NOTIFICATION_URL = "https://local.a2a.invalid/notifications";

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
  expectedKind: Extract<AgentKind, "admin" | "onboarding">
): Promise<void> {
  const row = await getAgentTaskByToken(token);
  if (!row || row.status === "completed") return;

  const agent = await getAgent(row.agentName);
  if (!agent || agent.kind !== expectedKind) {
    throw new Error(
      "local task does not belong to the expected built-in agent"
    );
  }
  await deliverTaskToSlack(token, row, agent, task, (text) => text);
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
    private readonly agentKind: Extract<AgentKind, "admin" | "onboarding">
  ) {}

  send(task: Task): Promise<void> {
    const delivery = this.deliveryChain.then(() => this.deliver(task));
    // Keep later notifications deliverable after a failed Slack/API call.
    this.deliveryChain = delivery.catch(() => undefined);
    return delivery;
  }

  private async deliver(task: Task): Promise<void> {
    // The initial submitted Task establishes acceptance only. It must not be
    // treated as a user-visible progress update, even if it carries a message.
    if (task.status.state === "submitted") return;

    const configs = await this.pushNotificationStore.load(task.id);
    for (const config of configs) {
      if (config.url !== LOCAL_NOTIFICATION_URL || !config.token) continue;
      try {
        await deliverLocalAgentTask(config.token, task, this.agentKind);
      } catch (err) {
        console.error("[local-notifications] task delivery failed", {
          agentKind: this.agentKind,
          taskId: task.id,
          err: err instanceof Error ? err.message : String(err)
        });
        await recordAgentTaskError(
          config.token,
          "the local agent's reply could not be delivered"
        );
      }
    }
  }
}
