import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import { registerAgent, getAgent } from "@/db/models/agents";
import {
  completeAgentTask,
  createAgentTask,
  getAgentTaskByToken
} from "@/db/models/agent-tasks";
import { getHitlRequest } from "@/db/models/hitl-requests";
import { deliverTaskToSlack } from "@/a2a/notifications/shared";
import { HITL_REQUEST_TYPE } from "@/a2a/hitl";
import { dataPart, textPart } from "@/a2a/parts";
import type { TaskSnapshot } from "@/a2a/snapshot";
import { makeSnapshot } from "../helpers/a2a";

interface SlackPost {
  method: string;
  channel: string;
  text: string;
  blocks?: string;
  thread_ts?: string;
}

function stubFetch(posts: SlackPost[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("chat.postMessage")) {
        const raw =
          input instanceof Request
            ? await input.clone().text()
            : String(init?.body ?? "");
        const body = new URLSearchParams(raw);
        posts.push({
          method: "chat.postMessage",
          channel: body.get("channel") ?? "",
          text: body.get("text") ?? "",
          blocks: body.get("blocks") ?? undefined,
          thread_ts: body.get("thread_ts") ?? undefined
        });
        return Response.json({ ok: true, ts: "1700.9" });
      }
      return new Response("not found", { status: 404 });
    })
  );
}

function hitlTask(
  requestId: string,
  opts: { state?: TaskState; withDataPart?: boolean } = {}
): TaskSnapshot {
  const fallback = textPart("Proceed with deletion?");
  const request = dataPart({
    type: HITL_REQUEST_TYPE,
    requestId,
    requestKind: "approval",
    prompt: "Proceed with deletion?"
  });
  return makeSnapshot({
    id: "task-1",
    contextId: "C1:1700.1",
    state: opts.state ?? TaskState.TASK_STATE_INPUT_REQUIRED,
    messageId: `${requestId}:u1`,
    parts: opts.withDataPart === false ? [fallback] : [fallback, request]
  });
}

beforeEach(async () => {
  await registerAgent({
    name: "remoteagent",
    kind: "custom",
    a2aEndpoint: "https://agent.example.com/a2a",
    tenantId: "main",
    notifyOn: "mention",
    workspaceId: 0
  });
  await createAgentTask({
    token: "tok-del",
    taskId: "task-1",
    agentName: "remoteagent",
    channelId: "C1",
    messageTs: "1700.1",
    replyThreadTs: "1700.1",
    eventId: "Ev1"
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function deliver(snapshot: TaskSnapshot) {
  const row = await getAgentTaskByToken("tok-del");
  const agent = await getAgent("remoteagent");
  await deliverTaskToSlack("tok-del", row!, agent!, snapshot);
}

describe("deliverTaskToSlack — HITL input-required branch", () => {
  it("renders a Block Kit prompt, persists the request, and parks the task", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);

    await deliver(hitlTask("req-del-1"));

    // Posted an interactive (blocks) message into the thread.
    expect(posts).toHaveLength(1);
    expect(posts[0].blocks).toBeTruthy();
    // The action ids embed the requestId (that is the interaction correlation key).
    expect(posts[0].blocks).toContain("req-del-1");
    expect(posts[0].thread_ts).toBe("1700.1");

    // Persisted the request, awaiting an answer, with the Slack ts recorded.
    const req = await getHitlRequest("req-del-1");
    expect(req?.status).toBe("awaiting");
    expect(req?.taskId).toBe("task-1");
    expect(req?.contextId).toBe("C1:1700.1");
    expect(req?.slackMessageTs).toBe("1700.9");

    // Parked the paired task row (non-terminal, not drained).
    expect((await getAgentTaskByToken("tok-del"))?.status).toBe(
      "awaiting-input"
    );
  });

  it("does not double-post on an at-least-once redelivery", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);
    await deliver(hitlTask("req-del-2"));
    await deliver(hitlTask("req-del-2")); // same requestId redelivered
    expect(posts).toHaveLength(1);
  });

  it("does not post a prompt when the task completed concurrently", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);

    // A stale snapshot: the delivery boundary reads `row` (still pending) before
    // dispatching, then a terminal callback or 🛑 completes the task before this
    // input-required update parks it. `suspendForInput` no-ops against the now
    // completed row, so posting would strand a prompt whose answer can't resume.
    const staleRow = await getAgentTaskByToken("tok-del");
    await completeAgentTask("tok-del");

    const agent = await getAgent("remoteagent");
    await deliverTaskToSlack(
      "tok-del",
      staleRow!,
      agent!,
      hitlTask("req-race")
    );

    // No interactive prompt for a task that can no longer be resumed.
    expect(posts).toHaveLength(0);
    // The task stays terminal — the park was a no-op.
    expect((await getAgentTaskByToken("tok-del"))?.status).toBe("completed");
  });

  it("falls back to a plain reply for input-required without a HITL DataPart", async () => {
    const posts: SlackPost[] = [];
    stubFetch(posts);
    await deliver(hitlTask("req-none", { withDataPart: false }));

    // Posted as a normal reply (no blocks), and the row stays pending — no HITL row.
    expect(posts).toHaveLength(1);
    expect(posts[0].blocks).toBeUndefined();
    expect((await getAgentTaskByToken("tok-del"))?.status).toBe("pending");
  });
});
