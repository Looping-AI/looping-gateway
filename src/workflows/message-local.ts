import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { MessageWorkflowParams } from "@/slack/types";
import { postReply } from "@/wrappers/slack";
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
 * Dispatch one local (admin / onboarding) plan and handle its reply.
 *
 * Local agents reply synchronously — there is no async push-back, no
 * agent_tasks row, and no `accepted` outcome. The dispatch step either
 * returns a reply immediately or throws (causing the step to retry).
 */
async function runLocalAgentTask(
  step: WorkflowStep,
  p: MessageWorkflowParams,
  plan: AgentPlan,
  threadTs: string | null
): Promise<TaskOutcome> {
  let result;
  try {
    result = await step.do(`dispatch:${plan.agent.name}`, () =>
      dispatchMessage(p, plan)
    );
  } catch {
    return { kind: "unreachable" };
  }

  try {
    if (result.kind === "error_reply") {
      if (result.text.trim()) {
        await step.do(`error-reply:${plan.agent.name}`, () =>
          postReply(p.channelId, threadTs, result.text, null, null)
        );
      }
      return { kind: "done" };
    }

    if (result.kind === "reply" && result.text.trim()) {
      await step.do(`reply:${plan.agent.name}`, () =>
        postReply(
          p.channelId,
          threadTs,
          result.text,
          plan.displayName,
          plan.iconUrl
        )
      );
    }
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
 * Local agents are hosted as Durable Objects and reply synchronously, so the
 * full reply cycle completes within this workflow — no async push-back, no
 * agent_tasks rows. The ⏳ reaction is always cleared unconditionally when the
 * workflow finishes, because local and remote agents are registered on separate
 * channel types and a single event never wakes both kinds at once. See
 * ReactionWorkflow for the backstop that removes ⏳ if this workflow fails.
 *
 * Steps: `resolve` → one `dispatch:{name}` per agent → one `reply:{name}` per
 * non-empty reply → `collect-reaction`.
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
        if (outcome.kind === "unreachable") {
          await handleUnreachable(step, p, threadTs, plan.agent.name);
        } else if (outcome.kind === "internal_error") {
          console.error("[message-local] agent reply step failed", {
            agent: plan.agent.name,
            error: outcome.error
          });
        }
      }

      // Local agents always reply synchronously — no push-back is ever pending,
      // so the ⏳ can always be cleared once this workflow finishes.
      await step.do("collect-reaction", () => signalReactionCollect(p.eventId));
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
