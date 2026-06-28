import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { ReactionWorkflowParams } from "@/slack/types";
import { removeReaction } from "@/wrappers/slack";

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
      try {
        await step.waitForEvent("await collect signal", {
          type: REACTION_COLLECT_EVENT,
          timeout: REACTION_BACKSTOP_TIMEOUT
        });
      } catch (err) {
        console.log("[reaction] collect signal timed out — backstop cleanup", {
          instanceId: event.instanceId,
          eventId: p.eventId,
          channelId: p.channelId,
          error: err instanceof Error ? err.message : String(err)
        });
      }

      await step.do("remove-reaction", () =>
        removeReaction(this.env, p.channelId, p.ts, PENDING_REACTION)
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
