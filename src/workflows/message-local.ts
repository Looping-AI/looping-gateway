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
 * Dispatch one local (admin / onboarding) plan and handle its task acceptance.
 *
 * Local A2A status snapshots are delivered through the trusted in-process
 * sender. As with remote agents, write the correlation row before dispatch so a
 * status update can never outrun the record that routes it to Slack.
 */
async function runLocalAgentTask(
  step: WorkflowStep,
  p: MessageWorkflowParams,
  plan: AgentPlan,
  threadTs: string | null
): Promise<TaskOutcome> {
  const token = await step.do(`record-task:${plan.agent.name}`, async () => {
    const dispatchId = await buildDispatchId(p.eventId, plan.agent);
    await createAgentTask({
      token: dispatchId,
      taskId: null,
      agentName: plan.agent.name,
      channelId: p.channelId,
      replyThreadTs: threadTs,
      eventId: p.eventId
    });
    return dispatchId;
  });

  let result;
  try {
    result = await step.do(`dispatch:${plan.agent.name}`, () =>
      dispatchMessage(p, plan)
    );
  } catch (err) {
    await step.do(`unrecord-task:${plan.agent.name}`, () =>
      deleteAgentTask(token)
    );
    return {
      kind: "unreachable",
      error: err instanceof Error ? err.message : String(err)
    };
  }

  if (result.kind === "accepted") {
    await step.do(`update-task:${plan.agent.name}`, () =>
      updateAgentTaskTaskId(result.token, result.taskId)
    );
    return { kind: "accepted" };
  }

  // A non-accepted dispatch cannot emit task updates, so remove the prewritten
  // correlation row before surfacing its gateway-controlled error to the user.
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

    console.error(
      "[message-local] protocol violation: sync reply from local agent",
      { agent: plan.agent.name, kind: result.kind }
    );
    await step.do(`protocol-error:${plan.agent.name}`, () =>
      postReply(
        p.channelId,
        threadTs,
        `The local agent *${plan.agent.name}* responded synchronously instead of using the required task lifecycle.`,
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
 * Durable workflow for Slack messages dispatched to local (admin / onboarding)
 * agents. One instance per Slack `event_id`.
 *
 * Local agents are hosted as Durable Objects and deliver status snapshots through
 * a trusted in-process push sender. While an accepted task is pending, the ⏳
 * reaction remains until terminal delivery completes it; ReactionWorkflow stays
 * the backstop if a notification cannot be delivered.
 *
 * Steps: `resolve` → one `record-task:{name}` + `dispatch:{name}` per agent →
 * `update-task:{name}` on accept → `collect-reaction` when nothing is pending.
 */
export class LocalMessageWorkflow extends WorkflowEntrypoint<
  Env,
  MessageWorkflowParams
> {
  async run(event: WorkflowEvent<MessageWorkflowParams>, step: WorkflowStep) {
    const p = event.payload;
    const threadTs = replyThreadTs(p);

    try {
      const plans = await step.do("resolve", () => resolveMessage(p));

      const results = await Promise.allSettled(
        plans.map((plan) => runLocalAgentTask(step, p, plan, threadTs))
      );

      let anyAccepted = false;
      for (const [i, r] of results.entries()) {
        const plan = plans[i];
        if (r.status === "rejected") {
          console.error("[message-local] agent task threw unexpectedly", {
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
          console.error("[message-local] agent reply step failed", {
            agent: plan.agent.name,
            error: outcome.error
          });
        }
      }

      if (!anyAccepted) {
        await step.do("collect-reaction", () =>
          signalReactionCollect(p.eventId)
        );
      }
    } catch (err) {
      console.error("[message-local] workflow run failed", {
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
