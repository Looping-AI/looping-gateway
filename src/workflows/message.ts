import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { MessageWorkflowParams } from "@/slack/types";
import { getDb } from "@/db/client";
import { buildUserAuthContext } from "@/auth";
import { resolveTargets } from "@/router/resolve";
import {
  dispatchToAgent,
  type DispatchAgentRef,
  type DispatchMetadata
} from "@/agents/dispatch";
import { InvalidEndpointError } from "@/a2a/endpoint";
import { postReply } from "@/wrappers/slack";
import { getSlackChannelName } from "@/db/models/channels";
import {
  REACTION_COLLECT_EVENT,
  reactionInstanceId
} from "@/workflows/reaction";

// One agent's resolved dispatch target (must be Rpc.Serializable).
export interface AgentPlan {
  agent: DispatchAgentRef;
  /** Workspace scope of the agent; null = org-wide (onboarding). */
  workspaceId: number | null;
  text: string;
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

/** Resolve every agent woken by the message + build the caller's auth context. */
export async function resolveMessage(
  env: Env,
  p: MessageWorkflowParams
): Promise<AgentPlan[]> {
  const db = getDb(env);
  const targets = await resolveTargets(db, {
    channelId: p.channelId,
    text: p.text
  });
  if (targets.length === 0) return [];

  // `userId` is guaranteed by the classifier (message events without a sender
  // are ignored), so every caller has an auth context — unknown users get a
  // zero-permission one rather than null.
  const user = await buildUserAuthContext(db, p.userId);
  return targets.map((t) => ({
    agent: {
      name: t.agent.name,
      kind: t.agent.kind,
      a2aEndpoint: t.agent.a2aEndpoint,
      workspaceId: t.agent.workspaceId
    },
    workspaceId: t.workspaceId,
    text: feedText(p),
    user
  }));
}

/** Dispatch one resolved plan to its agent over A2A; returns the reply text (may be empty). */
export async function dispatchMessage(
  env: Env,
  p: MessageWorkflowParams,
  plan: AgentPlan
): Promise<string> {
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
    return await dispatchToAgent(env, plan.agent, {
      text: plan.text,
      channelId: p.channelId,
      channelName: await getSlackChannelName(getDb(env), p.channelId),
      threadTs: p.threadTs || p.ts,
      messageTs: p.ts,
      user: plan.user,
      metadata
    });
  } catch (err) {
    if (err instanceof InvalidEndpointError) {
      // Policy rejection — not a transient error, so don't let the workflow
      // retry. Stay silent rather than posting an error for one agent.
      console.warn("[message] agent endpoint rejected", {
        agent: plan.agent.name,
        err: err.message
      });
      return "";
    }
    throw err;
  }
}

/**
 * Tell the parallel ReactionWorkflow that a reply was posted so it collects
 * (removes) the pending ⏳ reaction immediately. Best-effort: any failure is
 * logged, not thrown — the reaction is cosmetic and the ReactionWorkflow's
 * timeout backstop removes it regardless.
 */
export async function signalReactionCollect(
  env: Env,
  eventId: string
): Promise<void> {
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
 * `event_id`. The Gateway no longer picks a single agent — it fans the turn out
 * to every agent woken by the event (proactive `channel_messages` + any named
 * `mention` agents); each agent classifies internally and may stay silent.
 *
 * Steps: `resolve` (registry + auth) → one `dispatch:{name}` per agent (A2A) →
 * one `reply:{name}` per non-empty reply (chat.postMessage). Agents run in
 * parallel; allSettled isolates per-agent failures so one agent's exhausted
 * retries never blocks the others or aborts the run, and silence (empty reply)
 * posts nothing.
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
      const plans = await step.do("resolve", () => resolveMessage(this.env, p));

      // Fan out to every agent in parallel; allSettled isolates failures so one
      // agent's exhausted retries never blocks the others or aborts the run.
      const results = await Promise.allSettled(
        plans.map(async (plan) => {
          const reply = await step.do(`dispatch:${plan.agent.name}`, () =>
            dispatchMessage(this.env, p, plan)
          );
          if (reply.trim()) {
            await step.do(`reply:${plan.agent.name}`, () =>
              postReply(this.env, p.channelId, threadTs, reply)
            );
          }
        })
      );
      for (const [i, r] of results.entries()) {
        if (r.status === "rejected") {
          console.error("[message] agent dispatch failed", {
            agent: plans[i].agent.name,
            error:
              r.reason instanceof Error ? r.reason.message : String(r.reason)
          });
        }
      }

      // Always clear the ⏳ once every agent has settled — reply or silence.
      await step.do("collect-reaction", () =>
        signalReactionCollect(this.env, p.eventId)
      );
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
