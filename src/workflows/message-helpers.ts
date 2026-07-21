import type { WorkflowStep } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import type { MessageWorkflowParams } from "@/slack/types";
import { buildUserAuthContext } from "@/auth";
import {
  cancelAgentTask,
  dispatchToAgent,
  type DispatchAgentRef,
  type DispatchMetadata,
  type DispatchResult
} from "@/agents/dispatch";
import { InvalidEndpointError } from "@/a2a/endpoint";
import {
  completeAgentTask,
  getPendingAgentTasksByEventId
} from "@/db/models/agent-tasks";
import { renderEditDiff } from "@/util/text-diff";
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
const MAX_UNREACHABLE_ERROR_TEXT_LENGTH = 240;

function unreachableErrorText(error: string): string {
  const normalized = error.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length <= MAX_UNREACHABLE_ERROR_TEXT_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_UNREACHABLE_ERROR_TEXT_LENGTH - 3)}...`;
}

export function agentUnreachableText(agentName: string, error: string): string {
  const base = agentName
    ? `${AGENT_UNREACHABLE_BASE_TEXT} (Agent: *${agentName}*.)`
    : AGENT_UNREACHABLE_BASE_TEXT;
  const reason = unreachableErrorText(error);
  return reason ? `${base} Last error: ${reason}` : base;
}

// One agent's resolved dispatch target (must be Rpc.Serializable).
export interface AgentPlan {
  agent: DispatchAgentRef;
  /** Workspace scope of the agent; null = org-wide (onboarding). */
  workspaceId: number | null;
  text: string;
  /** Channel display name, resolved once in resolveMessage for the fan-out. */
  channelName: string | null;
  // No display name / icon here: the workflow only dispatches, it never posts an
  // agent's reply. Rendering identity is resolved at the delivery boundary
  // (`agentRenderIdentity`) from the agent row current when the reply lands.
  user: Awaited<ReturnType<typeof buildUserAuthContext>>;
}

// ---------------------------------------------------------------------------
// Pure steps — called by MessageWorkflow and exported for tests.
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
 *
 * Edits send only a compact diff (the agent already holds the prior message in
 * session), not both full bodies — see {@link renderEditDiff}.
 */
export function feedText(p: MessageWorkflowParams): string {
  if (p.editKind === "deleted") {
    return `[deleted a message (ts ${p.ts})] ${p.prevText ?? ""}`.trim();
  }
  if (p.editKind === "edited") {
    const diff = renderEditDiff(p.prevText ?? "", p.text);
    return `[edited a message (ts ${p.ts})] changed:\n${diff}`;
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
    user
  }));
}

/**
 * Dispatch one resolved plan to its agent over A2A. Every agent accepts a Task
 * (`{ kind: "accepted" }`) and delivers status snapshots later: remote agents
 * through the authenticated callback and built-ins through the trusted local
 * sender.
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
 * (removes) the 🛑 stop reaction immediately. Best-effort: any failure is
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
 * Collect (remove) the 🛑 reaction only once the whole fan-out for a trigger
 * event has drained — i.e. no `pending` task remains for it. A single Slack
 * message can wake several agents; each finishes independently, so the reaction
 * must linger until the *last* one is terminal (otherwise it clears on the first
 * completion and the user loses the ability to stop the rest). Called at every
 * point a task leaves the pending set: a terminal delivery, and the end of the
 * MessageWorkflow (after non-accepts/unreachables have been unrecorded).
 *
 * Race note: this is only reliable because every fan-out row is recorded up front
 * (before any dispatch), so a fast terminal callback can never observe an
 * incomplete sibling set and drain early.
 */
export async function collectIfEventDrained(eventId: string): Promise<void> {
  const pending = await getPendingAgentTasksByEventId(eventId);
  if (pending.length === 0) {
    await signalReactionCollect(eventId);
  }
}

/**
 * What happened to one task when we tried to stop it.
 * - `stopped`     — canceled, already terminal, unknown to the agent, or intent
 *                   recorded for a not-yet-accepted task (all "it will stop / is
 *                   stopped" from the user's view).
 * - `unsupported` — the agent doesn't implement cancellation; it keeps running.
 * - `error`       — a transport/other failure; best-effort, left to finish.
 */
export type CancelRowKind = "stopped" | "unsupported" | "error";

/**
 * Ask an agent to stop `taskId` and reconcile the ledger row from the outcome.
 *
 * Cancellation is *attempted*, not guaranteed (A2A §7.5). Only the terminal /
 * idempotent outcomes (`canceled`, `not_cancelable`, `not_found`) mean the agent
 * will send no further callback, so only those complete the row. On `unsupported`
 * or `error` the task is still running and may yet deliver a valid reply — the
 * row must stay `pending` so that callback still routes to Slack (and the 🛑
 * lingers until it lands) instead of being dropped against a completed row.
 */
export async function cancelAndReconcile(
  agent: DispatchAgentRef,
  taskId: string,
  token: string
): Promise<CancelRowKind> {
  const outcome = await cancelAgentTask(agent, taskId);
  switch (outcome.kind) {
    case "canceled":
    case "not_cancelable":
    case "not_found":
      await completeAgentTask(token);
      return "stopped";
    case "unsupported":
      return "unsupported";
    case "error":
      return "error";
  }
}

/**
 * Notice posted when a stop wasn't honored and the agent runs to completion —
 * for both `unsupported` and `error`. The cause differs but the user-visible
 * consequence is identical (a reply is still coming), and the gateway shouldn't
 * leak transport detail into the thread.
 */
export function cancelNotHonoredText(agentName: string): string {
  return `*Agent ${agentName}* can't be stopped mid-run and will finish on its own.`;
}

/**
 * Result of running one agent's dispatch + reply within the fan-out. The task
 * catches every *expected* failure and reports it here (rather than rejecting)
 * so the workflow can react precisely instead of collapsing everything into a
 * single "dispatch failed" notice.
 *
 * - `accepted`      — the agent took the turn and will deliver its reply later;
 *                     the 🛑 must linger until its callback (or backstop) clears it.
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
  | { kind: "unreachable"; error: string }
  | { kind: "internal_error"; error: string };

/**
 * Post the "agent unreachable" notice and dispatch-failed error handling the
 * workflow runs when a task returns `{ kind: "unreachable" }`.
 */
export async function handleUnreachable(
  step: WorkflowStep,
  p: MessageWorkflowParams,
  threadTs: string | null,
  agentName: string,
  error: string
): Promise<void> {
  console.error("[message] agent dispatch failed", {
    agent: agentName,
    error
  });
  try {
    await step.do(`dispatch-failed:${agentName}`, () =>
      postReply(
        p.channelId,
        threadTs,
        agentUnreachableText(agentName, error),
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
