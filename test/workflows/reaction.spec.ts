import { afterEach, describe, it, expect, vi } from "vitest";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  PENDING_REACTION,
  REACTION_COLLECT_EVENT,
  reactionInstanceId
} from "@/workflows/reaction";
import type { ReactionWorkflowParams } from "@/slack/types";
import { registerAgent } from "@/db/models/agents";
import {
  createAgentTask,
  recordAgentTaskError,
  getAgentTaskByToken
} from "@/db/models/agent-tasks";
import { stubSlack } from "../wrappers/slack-stub";

afterEach(() => vi.unstubAllGlobals());

interface ReactionCall {
  method: string;
  channel: string;
  timestamp: string;
  name: string;
}

interface PostCall {
  channel: string;
  text: string;
}

/** Record every reactions.add/remove call; all Slack calls resolve ok. */
function captureReactions(): ReactionCall[] {
  const calls: ReactionCall[] = [];
  stubSlack((method, body) => {
    if (method === "reactions.add" || method === "reactions.remove") {
      calls.push({
        method,
        channel: body.get("channel") ?? "",
        timestamp: body.get("timestamp") ?? "",
        name: body.get("name") ?? ""
      });
    }
    return { ok: true };
  });
  return calls;
}

/** Record reactions and chat.postMessage calls together for the backstop tests. */
function captureReactionsAndPosts(): {
  reactions: ReactionCall[];
  posts: PostCall[];
} {
  const reactions: ReactionCall[] = [];
  const posts: PostCall[] = [];
  stubSlack((method, body) => {
    if (method === "reactions.add" || method === "reactions.remove") {
      reactions.push({
        method,
        channel: body.get("channel") ?? "",
        timestamp: body.get("timestamp") ?? "",
        name: body.get("name") ?? ""
      });
    } else if (method === "chat.postMessage") {
      posts.push({
        channel: body.get("channel") ?? "",
        text: body.get("text") ?? ""
      });
    }
    return { ok: true, ts: "1700.9" };
  });
  return { reactions, posts };
}

/** Seed a pending remote task (and its agent) for `eventId`. */
async function seedPendingTask(
  eventId: string,
  token: string,
  lastError?: string
): Promise<void> {
  await registerAgent({
    name: token, // unique per task to avoid cross-test collisions
    kind: "custom",
    displayName: "Remote",
    a2aEndpoint: "https://agent.example.com/a2a",
    notifyOn: "mention",
    workspaceId: 0
  });
  await createAgentTask({
    token,
    taskId: "task-1",
    agentName: token,
    channelId: "C1",
    replyThreadTs: null,
    eventId
  });
  if (lastError) await recordAgentTaskError(token, lastError);
}

let seq = 0;
function makeParams(): ReactionWorkflowParams {
  return { eventId: `Ev-react-${++seq}`, channelId: "C1", ts: "1700.1" };
}

describe("ReactionWorkflow", () => {
  it("removes the pending reaction when the collect signal arrives", async () => {
    const calls = captureReactions();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      // Resolve the waitForEvent as if the MessageWorkflow signaled a posted reply.
      await introspector.modifyAll(async (m) => {
        await m.mockEvent({ type: REACTION_COLLECT_EVENT, payload: {} });
      });

      const p = makeParams();
      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });

      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // The reaction is *added* inline by the webhook handler, not here — this
      // workflow only removes it.
      expect(calls.map((c) => c.method)).toEqual(["reactions.remove"]);
      expect(calls[0]).toMatchObject({
        channel: "C1",
        timestamp: "1700.1",
        name: PENDING_REACTION
      });
    } finally {
      await introspector.dispose();
    }
  });

  it("removes the reaction on the timeout backstop when no signal ever arrives", async () => {
    const calls = captureReactions();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      // Simulate a MessageWorkflow crash: the collect signal never comes, so the
      // wait times out and the backstop must still remove the reaction.
      await introspector.modifyAll(async (m) => {
        await m.forceEventTimeout({ name: "await collect signal" });
      });

      const p = makeParams();
      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });

      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      expect(calls.map((c) => c.method)).toEqual(["reactions.remove"]);
    } finally {
      await introspector.dispose();
    }
  });

  it("on timeout, surfaces a rejected delivery and leaves the task pending", async () => {
    const { reactions, posts } = captureReactionsAndPosts();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      const p = makeParams();
      const token = `ntok-${p.eventId}`.toLowerCase();
      await seedPendingTask(
        p.eventId,
        token,
        "the callback signature could not be verified (expired)"
      );

      await introspector.modifyAll(async (m) => {
        await m.forceEventTimeout({ name: "await collect signal" });
      });

      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });
      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // The captured reason is surfaced to the user...
      expect(posts).toHaveLength(1);
      expect(posts[0].channel).toBe("C1");
      expect(posts[0].text).toContain("failed to deliver");
      expect(posts[0].text).toContain(token);
      expect(posts[0].text).toContain("signature could not be verified");
      // ...and the reaction is still removed.
      expect(reactions.map((c) => c.method)).toEqual(["reactions.remove"]);
      // Crucially, the backstop never terminalizes the row — a late but valid
      // callback must still be able to post its real reply.
      expect((await getAgentTaskByToken(token))?.status).toBe("pending");
    } finally {
      await introspector.dispose();
    }
  });

  it("on timeout, stays silent for a pending task with no captured error", async () => {
    const { reactions, posts } = captureReactionsAndPosts();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      const p = makeParams();
      const token = `ntok-${p.eventId}`.toLowerCase();
      // Pending, but no lastError: the remote may still be legitimately working,
      // so we must not claim failure.
      await seedPendingTask(p.eventId, token);

      await introspector.modifyAll(async (m) => {
        await m.forceEventTimeout({ name: "await collect signal" });
      });

      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });
      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      expect(posts).toHaveLength(0);
      expect(reactions.map((c) => c.method)).toEqual(["reactions.remove"]);
      expect((await getAgentTaskByToken(token))?.status).toBe("pending");
    } finally {
      await introspector.dispose();
    }
  });
});
