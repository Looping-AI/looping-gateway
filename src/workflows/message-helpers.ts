import type { WorkflowStep } from "cloudflare:workers";
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
import {
  REACTION_COLLECT_EVENT,
  reactionInstanceId
} from "@/workflows/reaction";

// Shown when a dispatch's retries are fully exhausted (persistently unreachable
// endpoint, TLS/DNS failure, persistent 5xx, accept timeout). Not transient by
// the time we get here, so the user should know rather than see silence.
export const AGENT_UNREACHABLE_BASE_TEXT =
  "This agent couldn't be reached after several attempts. It may be down or misconfigured, please contact the agent developer.";

export function agentUnreachableText(agentName?: string): string {
  if (!agentName) return AGENT_UNREACHABLE_BASE_TEXT;
  return `${AGENT_UNREACHABLE_BASE_TEXT} (Agent: *${agentName}*.)`;
}

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
// Pure steps — called by LocalMessageWorkflow / RemoteMessageWorkflow and
// exported for tests.
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
    const { workspaceId } = plan;
    if (workspaceId == null) {
      throw new Error("BUG: custom agent resolved without a workspaceId");
    }
    metadata = { agentKind: "custom", workspaceId };
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

/**
 * Result of running one agent's dispatch + reply within the fan-out. The task
 * catches every *expected* failure and reports it here (rather than rejecting)
 * so the workflow can react precisely instead of collapsing everything into a
 * single "dispatch failed" notice.
 *
 * - `accepted`      — a remote agent took the turn and will push its reply later;
 *                     the ⏳ must linger until its callback (or backstop) clears it.
 * - `done`          — handled fully now (sync reply posted, silence, or a policy
 *                     error notice posted); nothing is still working.
 * - `unreachable`   — the `dispatch` step itself exhausted retries; the user
 *                     should see `agentUnreachableText(...)`.
 * - `internal_error`— the agent responded but a later step (usually the Slack
 *                     post) exhausted retries; distinct from unreachable.
 */
export type TaskOutcome =
  | { kind: "accepted" }
  | { kind: "done" }
  | { kind: "unreachable" }
  | { kind: "internal_error"; error: string };

/**
 * Post the "agent unreachable" notice and dispatch-failed error handling shared
 * by both local and remote workflows when a task returns `{ kind: "unreachable" }`.
 */
export async function handleUnreachable(
  step: WorkflowStep,
  p: MessageWorkflowParams,
  threadTs: string | null,
  agentName: string
): Promise<void> {
  console.error("[message] agent dispatch failed", { agent: agentName });
  try {
    await step.do(`dispatch-failed:${agentName}`, () =>
      postReply(
        p.channelId,
        threadTs,
        agentUnreachableText(agentName),
        null,
        null
      )
    );
  } catch (postErr) {
    console.error("[message] failed to post unreachable notice", {
      agent: agentName,
      error: postErr instanceof Error ? postErr.message : String(postErr)
    });
  }
}
