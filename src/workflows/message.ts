import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import type { MessageWorkflowParams } from "@/slack/types";
import { buildUserAuthContext } from "@/auth";
import {
  dispatchToAgent,
  type DispatchAgentRef,
  type DispatchMetadata,
  type DispatchResult
} from "@/agents/dispatch";
import { InvalidEndpointError } from "@/a2a/endpoint";
import { postReply } from "@/wrappers/slack";
import { createAgentTask } from "@/db/models/agent-tasks";
import {
  REACTION_COLLECT_EVENT,
  reactionInstanceId
} from "@/workflows/reaction";

// Shown when a dispatch's retries are fully exhausted (persistently unreachable
// endpoint, TLS/DNS failure, persistent 5xx, accept timeout). Not transient by
// the time we get here, so the user should know rather than see silence.
export const AGENT_UNREACHABLE_TEXT =
  "This agent couldn't be reached after several attempts. It may be down or misconfigured, please contact the agent developer.";

// One agent's resolved dispatch target (must be Rpc.Serializable).
export interface AgentPlan {
  agent: DispatchAgentRef;
  /** Workspace scope of the agent; null = org-wide (onboarding). */
  workspaceId: number | null;
  text: string;
  /** Channel display name, resolved once in resolveMessage for the fan-out. */
  channelName: string | null;
  /**
   * Name to render this agent's Slack reply under (chat.postMessage `username`).
   * The agent's display name, falling back to its machine name — resolved here
   * so it's never null.
   */
  displayName: string;
  /** Icon URL for the agent's avatar in Slack (chat.postMessage `icon_url`). Null = use default bot icon. */
  iconUrl: string | null;
  user: Awaited<ReturnType<typeof buildUserAuthContext>>;
}

// ---------------------------------------------------------------------------
// Pure steps — called directly by MessageWorkflow.run() and exported for tests.
// ---------------------------------------------------------------------------

/**
 * Return the thread_ts to reply into, or null to post at channel level.
 * A real thread reply has a thread_ts that differs from the message's own ts.
 */
export function replyThreadTs(p: MessageWorkflowParams): string | null {
  return p.threadTs && p.threadTs !== p.ts ? p.threadTs : null;
}

/**
 * Render the body fanned out to agents. Plain turns carry the user text; edits
 * and deletes become a feed turn describing the change so agents stay aware of
 * the evolving channel reality (A2A has no edit/delete primitive).
 */
export function feedText(p: MessageWorkflowParams): string {
  if (p.editKind === "deleted") {
    return `[deleted a message (ts ${p.ts})] ${p.prevText ?? ""}`.trim();
  }
  if (p.editKind === "edited") {
    return `[edited a message (ts ${p.ts})] before: ${p.prevText ?? ""} | after: ${p.text}`;
  }
  return p.text;
}

/** Build dispatch plans from the targets resolved in the handler + auth context. */
export async function resolveMessage(
  p: MessageWorkflowParams
): Promise<AgentPlan[]> {
  const targets = p.targets;
  if (targets.length === 0) return [];

  // `userId` is guaranteed by the classifier (message events without a sender
  // are ignored), so every caller has an auth context — unknown users get a
  // zero-permission one rather than null.
  const user = await buildUserAuthContext(p.userId);
  return targets.map((t) => ({
    agent: {
      name: t.agent.name,
      kind: t.agent.kind,
      a2aEndpoint: t.agent.a2aEndpoint,
      workspaceId: t.agent.workspaceId
    },
    workspaceId: t.workspaceId,
    text: feedText(p),
    channelName: t.channelName,
    displayName: t.agent.displayName ?? t.agent.name,
    iconUrl: t.agent.iconUrl ?? null,
    user
  }));
}

/**
 * Dispatch one resolved plan to its agent over A2A. Local agents reply
 * synchronously (`{ kind: "reply" }`); remote agents only *accept* here and push
 * their reply later (`{ kind: "accepted" }`).
 *
 * Retry policy. A rejected endpoint (`InvalidEndpointError`) is a policy verdict,
 * not a transient fault: stay silent and do NOT retry. Everything else (network
 * blip, accept timeout) is thrown so the `dispatch` step retries — which is safe
 * now because the dispatch id is deterministic (`buildDispatchId`), so a re-send
 * carries the same A2A `messageId` and push `token`; a conformant remote dedupes
 * on the `messageId` instead of appending the turn twice, giving at-least-once
 * delivery with exactly-once effect.
 */
export async function dispatchMessage(
  p: MessageWorkflowParams,
  plan: AgentPlan
): Promise<DispatchResult> {
  let metadata: DispatchMetadata; // per-kind extras only
  if (plan.agent.kind === "admin") {
    if (plan.workspaceId == null) {
      throw new Error("BUG: admin agent resolved without a workspaceId");
    }
    metadata = { agentKind: "admin", adminWorkspaceId: plan.workspaceId };
  } else if (plan.agent.kind === "onboarding") {
    metadata = { agentKind: "onboarding" };
  } else {
    metadata = { agentKind: "custom", workspaceId: plan.workspaceId };
  }

  try {
    return await dispatchToAgent(plan.agent, {
      eventId: p.eventId,
      text: plan.text,
      channelId: p.channelId,
      channelName: plan.channelName,
      threadTs: p.threadTs || p.ts,
      messageTs: p.ts,
      user: plan.user,
      metadata
    });
  } catch (err) {
    if (err instanceof InvalidEndpointError) {
      // Policy rejection — not transient, so don't let the step retry.
      console.warn("[message] agent endpoint rejected", {
        agent: plan.agent.name,
        err: err.message
      });
      return {
        kind: "error_reply",
        text: `The agent *${plan.agent.name}* could not be reached because its endpoint was rejected by the security policy: ${err.message}. Please contact the agent developer to resolve this.`
      };
    }
    throw err; // transient — retry is safe (deterministic dispatch id dedupes)
  }
}

/**
 * Tell the parallel ReactionWorkflow that a reply was posted so it collects
 * (removes) the pending ⏳ reaction immediately. Best-effort: any failure is
 * logged, not thrown — the reaction is cosmetic and the ReactionWorkflow's
 * timeout backstop removes it regardless.
 */
export async function signalReactionCollect(eventId: string): Promise<void> {
  try {
    const instance = await env.REACTION_WORKFLOW.get(
      reactionInstanceId(eventId)
    );
    await instance.sendEvent({ type: REACTION_COLLECT_EVENT, payload: {} });
  } catch (err) {
    console.warn("[message] reaction collect signal failed (non-fatal)", {
      eventId,
      err: String(err)
    });
  }
}

// ---------------------------------------------------------------------------
// Workflow — durable orchestration over the steps above.
// ---------------------------------------------------------------------------

/**
 * Durable, retriable handler for a Slack message. One instance per Slack
 * `event_id`. The Gateway no longer picks a single agent — the woken agents are
 * resolved up front in the webhook handler and passed in on `params.targets`
 * (proactive `channel_messages` + any named `mention` agents); each agent
 * classifies internally and may stay silent.
 *
 * Steps: `resolve` (build auth + plans from targets) → one `dispatch:{name}` per
 * agent (A2A) → one `reply:{name}` per non-empty reply (chat.postMessage). Agents
 * run in parallel; allSettled isolates per-agent failures so one agent's
 * exhausted retries never blocks the others or aborts the run, and silence
 * (empty reply) posts nothing.
 */
export class MessageWorkflow extends WorkflowEntrypoint<
  Env,
  MessageWorkflowParams
> {
  async run(event: WorkflowEvent<MessageWorkflowParams>, step: WorkflowStep) {
    const p = event.payload;
    const threadTs = replyThreadTs(p);

    // Wrap the whole run so a failing step surfaces with detail. Without this,
    // a step whose retries are exhausted bubbles up as Cloudflare's opaque
    // "workflow" exception log (just the workflow name, no cause). The agent
    // dispatch (A2A) and the Slack post (chat.postMessage) throw on transient
    // errors that are otherwise invisible. We log the real cause, then rethrow
    // to preserve retry/backoff.
    try {
      const plans = await step.do("resolve", () => resolveMessage(p));

      // Fan out to every agent in parallel; allSettled isolates failures so one
      // agent's exhausted retries never blocks the others or aborts the run. Each
      // task resolves to `true` when it left a remote agent working asynchronously
      // (an accepted push-notification task), so we know whether the ⏳ must linger.
      const results = await Promise.allSettled(
        plans.map(async (plan) => {
          const result = await step.do(`dispatch:${plan.agent.name}`, () =>
            dispatchMessage(p, plan)
          );

          if (result.kind === "accepted") {
            // Remote agent accepted the turn; the real reply arrives later via
            // /a2a/notifications. Persist the correlation so the callback knows
            // where to post and which ⏳ to clear.
            await step.do(`record-task:${plan.agent.name}`, () =>
              createAgentTask({
                token: result.token,
                taskId: result.taskId,
                agentName: plan.agent.name,
                channelId: p.channelId,
                replyThreadTs: threadTs,
                eventId: p.eventId
              })
            );
            return true;
          }

          if (result.kind === "error_reply") {
            // Gateway error notice (policy rejection, etc.) — use app branding,
            // not the agent's, since this is the gateway speaking, not the agent.
            if (result.text.trim()) {
              await step.do(`error-reply:${plan.agent.name}`, () =>
                postReply(p.channelId, threadTs, result.text, null, null)
              );
            }
            return false;
          }

          // Synchronous local reply (empty = silence, posts nothing).
          if (result.text.trim()) {
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
          return false;
        })
      );

      let anyAccepted = false;
      for (const [i, r] of results.entries()) {
        if (r.status === "rejected") {
          const plan = plans[i];
          console.error("[message] agent dispatch failed", {
            agent: plan.agent.name,
            error:
              r.reason instanceof Error ? r.reason.message : String(r.reason)
          });
          // Retries are exhausted (not transient anymore) — tell the user the
          // agent couldn't be reached instead of silently clearing the ⏳ below.
          // Best-effort: a failed post here must not abort the run or block the
          // collect-reaction step, so isolate it (the cause is already logged).
          try {
            await step.do(`dispatch-failed:${plan.agent.name}`, () =>
              postReply(
                p.channelId,
                threadTs,
                AGENT_UNREACHABLE_TEXT,
                null,
                null
              )
            );
          } catch (postErr) {
            console.error("[message] failed to post unreachable notice", {
              agent: plan.agent.name,
              error:
                postErr instanceof Error ? postErr.message : String(postErr)
            });
          }
        } else if (r.value === true) {
          anyAccepted = true;
        }
      }

      // Clear the ⏳ now only when no agent is still working. A pending remote
      // task keeps it until its push-notification callback collects it (or the
      // ReactionWorkflow backstop times out) — so the hourglass reflects reality.
      if (!anyAccepted) {
        await step.do("collect-reaction", () =>
          signalReactionCollect(p.eventId)
        );
      }
    } catch (err) {
      console.error("[message] workflow run failed", {
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
