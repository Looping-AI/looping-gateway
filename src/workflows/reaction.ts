import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { ReactionWorkflowParams } from "@/slack/types";
import { removeReaction, postReply } from "@/wrappers/slack";
import { getPendingAgentTasksByEventId } from "@/db/models/agent-tasks";

/**
 * Emoji reaction used to signal "the agent is working on this message". Slack's
 * animated hourglass; configurable here in one place. The reaction is *added*
 * inline by the webhook handler (so it shows immediately); this workflow only
 * owns its removal.
 */
export const PENDING_REACTION = "hourglass_flowing_sand";

/**
 * Event `type` the MessageWorkflow sends once a reply has been posted, telling
 * the ReactionWorkflow to collect (remove) the pending reaction immediately.
 * Slack event types only allow `[a-zA-Z0-9_-]` — no dots.
 */
export const REACTION_COLLECT_EVENT = "reply_posted";

/**
 * Backstop: the longest the pending reaction may linger if the MessageWorkflow
 * crashes or errors without ever sending the collect signal. When the wait times
 * out, the reaction is removed anyway.
 */
export const REACTION_BACKSTOP_TIMEOUT = "10 minutes";

/** Deterministic ReactionWorkflow instance id derived from the Slack event id. */
export function reactionInstanceId(eventId: string): string {
  return `react-${eventId}`;
}

/**
 * Backstop notice: an accepted turn whose delivery callback we saw explicitly
 * rejected (auth/malformed) and which never succeeded within the window. Past
 * tense on purpose — it stays truthful even if the remote retries and succeeds
 * later (the row is never terminalized here).
 */
function rejectedDeliveryText(agentName: string, reason: string): string {
  return `An attempt to deliver *${agentName}*'s reply was rejected: ${reason}. If you don't hear back, please contact the agent developer.`;
}

/**
 * On backstop timeout, surface any pending task that carries a captured
 * `lastError` (a delivery callback we rejected). Best-effort by contract: never
 * throws, so the caller's `remove-reaction` always runs, and so a step retry
 * can't re-post. Pending tasks without an error are left silent — absence of a
 * callback is not proof of failure. The row is never completed here; task
 * termination stays owned by the remote's successful callback.
 */
async function surfaceRejectedDeliveries(eventId: string): Promise<void> {
  try {
    const pending = await getPendingAgentTasksByEventId(eventId);
    for (const row of pending) {
      if (!row.lastError) continue;
      try {
        // App branding (null) — this is a gateway error notice, not an agent reply.
        await postReply(
          row.channelId,
          row.replyThreadTs,
          rejectedDeliveryText(row.agentName, row.lastError),
          null,
          null
        );
      } catch (err) {
        console.error("[reaction] failed to surface rejected delivery", {
          agent: row.agentName,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  } catch (err) {
    console.error("[reaction] failed to load pending tasks for backstop", {
      eventId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Parallel, durable owner of the ⏳ reaction *removal* for a single Slack
 * trigger message. The webhook handler adds the reaction inline (so it appears
 * immediately, without waiting for a workflow cold start); this workflow runs
 * alongside (never wraps) the MessageWorkflow and only removes it:
 *
 *   waitForEvent(collect | timeout) → remove-reaction
 *
 * The reply path of the MessageWorkflow sends the `reply_posted` event to collect
 * the reaction promptly. If that signal never arrives (hard crash, exhausted
 * retries), the `waitForEvent` timeout fires and the reaction is still removed —
 * so the trigger message never keeps a stale ⏳.
 */
export class ReactionWorkflow extends WorkflowEntrypoint<
  Env,
  ReactionWorkflowParams
> {
  async run(event: WorkflowEvent<ReactionWorkflowParams>, step: WorkflowStep) {
    const p = event.payload;
    try {
      // Wait for the reply to be posted, or fall through on timeout. waitForEvent
      // throws on timeout, so the catch is the backstop that still removes below.
      let timedOut = false;
      try {
        await step.waitForEvent("await collect signal", {
          type: REACTION_COLLECT_EVENT,
          timeout: REACTION_BACKSTOP_TIMEOUT
        });
      } catch (err) {
        timedOut = true;
        console.log("[reaction] collect signal timed out — backstop cleanup", {
          instanceId: event.instanceId,
          eventId: p.eventId,
          channelId: p.channelId,
          error: err instanceof Error ? err.message : String(err)
        });
      }

      // On timeout, tell the user about any delivery we saw explicitly rejected
      // (a pending task carrying a captured `lastError`). A pending task with no
      // error is left silent — the remote may still be legitimately working. We
      // never terminalize the row here: a late but valid callback must still be
      // able to post, so task completion stays owned by the remote's callback.
      if (timedOut) {
        await step.do("surface-rejected-deliveries", () =>
          surfaceRejectedDeliveries(p.eventId)
        );
      }

      await step.do("remove-reaction", () =>
        removeReaction(p.channelId, p.ts, PENDING_REACTION)
      );
    } catch (err) {
      console.error("[reaction] workflow run failed", {
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
