import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { MessageWorkflowParams } from "@/slack/types";
import { getDb } from "@/db/client";
import { buildUserAuthContext } from "@/auth";
import { resolveTarget, isDmChannel } from "@/router/resolve";
import { dispatchToAgent, type DispatchAgentRef } from "@/agents/dispatch";
import { postReply } from "@/wrappers/slack";

export const NO_AGENT_HINT =
  "I'm not set up to help in this channel yet. Ask a workspace admin to allow an agent here and ::agent-name reference it.";

// What the resolve step hands to the later steps (must be Rpc.Serializable).
export type MessagePlan =
  | { kind: "none"; userMessage?: string }
  | {
      kind: "agent";
      agent: DispatchAgentRef;
      workspaceId: number | null;
      text: string;
      user: Awaited<ReturnType<typeof buildUserAuthContext>> | null;
    };

// ---------------------------------------------------------------------------
// Pure steps — called directly by MessageWorkflow.run() and exported for tests.
// ---------------------------------------------------------------------------

/** Reply in-thread for channel mentions; top-level for DMs. */
export function replyThreadTs(p: MessageWorkflowParams): string | null {
  return isDmChannel(p.channelId) ? null : p.threadTs || p.ts;
}

/** Resolve the target agent + build the caller's auth context. */
export async function resolveMessage(
  env: Env,
  p: MessageWorkflowParams
): Promise<MessagePlan> {
  const db = getDb(env);
  const target = await resolveTarget(db, {
    channelId: p.channelId,
    text: p.text
  });
  if (target.kind === "none")
    return { kind: "none", userMessage: target.userMessage };

  const user = p.userId ? await buildUserAuthContext(db, p.userId) : null;
  return {
    kind: "agent",
    agent: {
      name: target.agent.name,
      kind: target.agent.kind,
      a2aEndpoint: target.agent.a2aEndpoint
    },
    workspaceId: target.workspaceId,
    text: target.text,
    user
  };
}

/** Dispatch a resolved plan to its agent over A2A; returns the reply text. */
export async function dispatchMessage(
  env: Env,
  p: MessageWorkflowParams,
  plan: Extract<MessagePlan, { kind: "agent" }>
): Promise<string> {
  return dispatchToAgent(env, plan.agent, {
    text: plan.text,
    contextId: `${p.channelId}:${p.threadTs || p.ts}`,
    metadata: {
      user: plan.user,
      channelId: p.channelId,
      workspaceId: plan.workspaceId,
      slackTeamId: p.teamId ?? null,
      eventId: p.eventId
    }
  });
}

// ---------------------------------------------------------------------------
// Workflow — durable orchestration over the steps above.
// ---------------------------------------------------------------------------

/**
 * Durable, retriable handler for a user-addressed Slack message
 * (`app_mention` or DM). One instance per Slack `event_id`. All real processing
 * happens here, off the ack path.
 *
 * Steps are split so a failed Slack post retries without re-invoking the agent:
 * `resolve` (registry + auth) → `dispatch` (A2A) → `reply` (chat.postMessage).
 */
export class MessageWorkflow extends WorkflowEntrypoint<
  Env,
  MessageWorkflowParams
> {
  async run(event: WorkflowEvent<MessageWorkflowParams>, step: WorkflowStep) {
    const p = event.payload;
    const threadTs = replyThreadTs(p);

    const plan = await step.do("resolve", () => resolveMessage(this.env, p));

    if (plan.kind === "none") {
      await step.do("hint", () =>
        postReply(
          this.env,
          p.channelId,
          threadTs,
          plan.userMessage ?? NO_AGENT_HINT
        )
      );
      return;
    }

    const reply = await step.do("dispatch", () =>
      dispatchMessage(this.env, p, plan)
    );

    await step.do("reply", () =>
      postReply(this.env, p.channelId, threadTs, reply)
    );
  }
}
