import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { MessageWorkflowParams } from "@/slack/types";
import { buildDispatchId } from "@/agents/dispatch";
import { postReply } from "@/wrappers/slack";
import {
  createAgentTask,
  updateAgentTaskTaskId,
  deleteAgentTask
} from "@/db/models/agent-tasks";
import {
  type AgentPlan,
  type TaskOutcome,
  replyThreadTs,
  resolveMessage,
  dispatchMessage,
  signalReactionCollect,
  handleUnreachable
} from "@/workflows/message-helpers";

/**
 * Dispatch one remote (custom) plan and handle its outcome.
 *
 * Remote agents reply asynchronously via /a2a/notifications. An agent_tasks row
 * is written *before* dispatch so the push token is always present when the
 * callback arrives — closing the accept→record race. If the dispatch does not
 * end in `accepted` the pre-written row is deleted (no callback will arrive).
 *
 * The dispatch id is deterministic (`buildDispatchId`), making step retries
 * idempotent: a re-send carries the same A2A `messageId` so a conformant remote
 * dedupes instead of appending the turn twice.
 */
async function runRemoteAgentTask(
  step: WorkflowStep,
  p: MessageWorkflowParams,
  plan: AgentPlan,
  threadTs: string | null
): Promise<TaskOutcome> {
  // Pre-write the correlation row before dispatch so an accepted reply can never
  // be orphaned (404) by a post-accept failure. `createAgentTask` is idempotent
  // on the token PK, so step retries are safe.
  const token = await step.do(`record-task:${plan.agent.name}`, async () => {
    const t = await buildDispatchId(p.eventId, plan.agent);
    await createAgentTask({
      token: t,
      taskId: null,
      agentName: plan.agent.name,
      channelId: p.channelId,
      replyThreadTs: threadTs,
      eventId: p.eventId
    });
    return t;
  });

  let result;
  try {
    result = await step.do(`dispatch:${plan.agent.name}`, () =>
      dispatchMessage(p, plan)
    );
  } catch (err) {
    // Dispatch retries exhausted — genuinely unreachable. Remove the pre-written
    // row since no push callback will ever arrive.
    await step.do(`unrecord-task:${plan.agent.name}`, () =>
      deleteAgentTask(token)
    );
    return {
      kind: "unreachable",
      error: err instanceof Error ? err.message : String(err)
    };
  }

  if (result.kind === "accepted") {
    // Backfill the remote-assigned taskId now that the accept response carries
    // it (the row was written with a null taskId). The ⏳ lingers until the
    // callback clears it.
    await step.do(`update-task:${plan.agent.name}`, () =>
      updateAgentTaskTaskId(result.token, result.taskId)
    );
    return { kind: "accepted" };
  }

  // Non-accepted outcome — no callback is coming, so remove the pre-written row.
  await step.do(`unrecord-task:${plan.agent.name}`, () =>
    deleteAgentTask(token)
  );

  try {
    if (result.kind === "error_reply") {
      if (result.text.trim()) {
        await step.do(`error-reply:${plan.agent.name}`, () =>
          postReply(p.channelId, threadTs, result.text, null, null)
        );
      }
      return { kind: "done" };
    }

    // Remote agents must never return a sync `reply` — protocol violation.
    // Notify the user and log so it surfaces in observability.
    console.error(
      "[message-remote] protocol violation: sync reply from remote agent",
      {
        agent: plan.agent.name,
        kind: result.kind
      }
    );
    await step.do(`protocol-error:${plan.agent.name}`, () =>
      postReply(
        p.channelId,
        threadTs,
        `The agent *${plan.agent.name}* responded synchronously instead of using the required async callback. Please contact the agent developer.`,
        null,
        null
      )
    );
    return { kind: "done" };
  } catch (err) {
    return {
      kind: "internal_error",
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Durable workflow for Slack messages dispatched to remote (custom) agents.
 * One instance per Slack `event_id`.
 *
 * Remote agents accept the turn over HTTP and push their reply later via
 * /a2a/notifications. While any remote task is still pending (`anyAccepted`),
 * the ⏳ reaction lingers — the push-notification handler (or the ReactionWorkflow
 * backstop) removes it once the reply arrives.
 *
 * Remote and local agents are registered on separate channel types, so a single
 * event never wakes both kinds at once. This workflow always owns the
 * collect-reaction signal for any event that reaches it. See ReactionWorkflow
 * for the backstop that removes ⏳ if this workflow (or its callbacks) fails.
 *
 * Steps: `resolve` → one `record-task:{name}` + `dispatch:{name}` per agent →
 * `update-task:{name}` on accept → `collect-reaction` when nothing is pending.
 */
export class RemoteMessageWorkflow extends WorkflowEntrypoint<
  Env,
  MessageWorkflowParams
> {
  async run(event: WorkflowEvent<MessageWorkflowParams>, step: WorkflowStep) {
    const p = event.payload;
    const threadTs = replyThreadTs(p);

    try {
      const plans = await step.do("resolve", () => resolveMessage(p));

      const results = await Promise.allSettled(
        plans.map((plan) => runRemoteAgentTask(step, p, plan, threadTs))
      );

      let anyAccepted = false;
      for (const [i, r] of results.entries()) {
        const plan = plans[i];
        if (r.status === "rejected") {
          console.error("[message-remote] agent task threw unexpectedly", {
            agent: plan.agent.name,
            error:
              r.reason instanceof Error ? r.reason.message : String(r.reason)
          });
          continue;
        }

        const outcome = r.value;
        if (outcome.kind === "accepted") {
          anyAccepted = true;
        } else if (outcome.kind === "unreachable") {
          await handleUnreachable(
            step,
            p,
            threadTs,
            plan.agent.name,
            outcome.error
          );
        } else if (outcome.kind === "internal_error") {
          console.error("[message-remote] agent reply step failed", {
            agent: plan.agent.name,
            error: outcome.error
          });
        }
      }

      // Clear the ⏳ only when no remote agent is still working. A pending
      // accepted task keeps it alive until the push-notification callback
      // (or the ReactionWorkflow backstop) removes it.
      if (!anyAccepted) {
        await step.do("collect-reaction", () =>
          signalReactionCollect(p.eventId)
        );
      }
    } catch (err) {
      console.error("[message-remote] workflow run failed", {
        instanceId: event.instanceId,
        eventId: p.eventId,
        channelId: p.channelId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      });
      throw err;
    }
  }
}
