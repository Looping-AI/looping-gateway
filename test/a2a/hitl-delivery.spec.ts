import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Task, TaskState } from "@a2a-js/sdk";
import { registerAgent, getAgent } from "@/db/models/agents";
import { createAgentTask, getAgentTaskByToken } from "@/db/models/agent-tasks";
import { getHitlRequest } from "@/db/models/hitl-requests";
import { deliverTaskToSlack } from "@/a2a/notifications/shared";
import { HITL_REQUEST_TYPE } from "@/a2a/hitl";

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
): Task {
  const parts = [{ kind: "text" as const, text: "Proceed with deletion?" }];
  const dataPart = {
    kind: "data" as const,
    data: {
      type: HITL_REQUEST_TYPE,
      requestId,
      requestKind: "approval",
      prompt: "Proceed with deletion?"
    }
  };
  return {
    kind: "task",
    id: "task-1",
    contextId: "C1:1700.1",
    status: {
      state: opts.state ?? "input-required",
      message: {
        kind: "message",
        messageId: `${requestId}:u1`,
        role: "agent",
        contextId: "C1:1700.1",
        parts: opts.withDataPart === false ? parts : [...parts, dataPart]
      }
    }
  };
}

beforeEach(async () => {
  await registerAgent({
    name: "remoteagent",
    kind: "custom",
    a2aEndpoint: "https://agent.example.com/a2a",
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

async function deliver(task: Task) {
  const row = await getAgentTaskByToken("tok-del");
  const agent = await getAgent("remoteagent");
  await deliverTaskToSlack("tok-del", row!, agent!, task);
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
