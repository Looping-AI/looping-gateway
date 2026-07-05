import { describe, it, expect, afterEach, vi } from "vitest";
import type { Message, Task } from "@a2a-js/sdk";
import { acceptA2ARemote, sanitizeRemoteReply } from "@/a2a/client";
import { buildAgentCard } from "@/a2a/card";

const ENDPOINT = "https://remote.example.com/a2a";

function userMessage(text: string): Message {
  return {
    kind: "message",
    messageId: "m1",
    role: "user",
    parts: [{ kind: "text", text }],
    contextId: "C1:T1"
  };
}

interface Captured {
  url: string;
  method: string;
  authorization: string | null;
  body: string;
}

/**
 * Stub global fetch as a fake *async* remote A2A server:
 *  - GET  → the agent card (so the client's discovery succeeds),
 *  - POST → a `submitted` Task ack (the remote returns immediately and pushes the
 *    real reply later, per the push-notification contract).
 * Records every call so we can assert the injected Bearer header + params.
 */
function stubRemote(taskId: string, calls: Captured[]) {
  const card = buildAgentCard({
    name: "Remote",
    description: "remote test agent",
    url: ENDPOINT
  });

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const isReq = input instanceof Request;
      const url = isReq
        ? input.url
        : input instanceof URL
          ? input.toString()
          : String(input);
      const method = init?.method ?? (isReq ? input.method : "GET");
      const headers = new Headers(
        init?.headers ?? (isReq ? input.headers : undefined)
      );
      const body = isReq
        ? await input.clone().text()
        : String(init?.body ?? "");
      calls.push({
        url,
        method,
        authorization: headers.get("authorization"),
        body
      });

      if (method.toUpperCase() === "POST") {
        let id: unknown = 1;
        try {
          id = JSON.parse(body).id ?? 1;
        } catch {
          /* ignore */
        }
        const task: Task = {
          kind: "task",
          id: taskId,
          contextId: "C1:T1",
          status: { state: "submitted" }
        };
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id, result: task }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify(card), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  );
  vi.stubGlobal("fetch", fetchMock);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("acceptA2ARemote — async remote accept", () => {
  it("injects the gateway JWT as a Bearer header and sends the push config", async () => {
    const calls: Captured[] = [];
    stubRemote("task-1", calls);

    const result = await acceptA2ARemote(
      { endpoint: ENDPOINT, authToken: "tok-123" },
      userMessage("hi"),
      { url: "https://gw.example.com/a2a/notifications", token: "ntok-9" }
    );

    expect(result).toEqual({ kind: "accepted", taskId: "task-1" });

    const post = calls.find((c) => c.method.toUpperCase() === "POST");
    expect(post).toBeDefined();
    expect(post?.authorization).toBe("Bearer tok-123");
    // The push-notification config must ride on the message/send params.
    const parsed = JSON.parse(post?.body ?? "{}");
    const push = parsed.params?.configuration?.pushNotificationConfig;
    expect(push?.url).toBe("https://gw.example.com/a2a/notifications");
    expect(push?.token).toBe("ntok-9");
  });

  it("returns contract_violation when required Task acceptance/id is missing", async () => {
    const calls: Captured[] = [];
    const card = buildAgentCard({
      name: "Remote",
      description: "remote test agent",
      url: ENDPOINT
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const isReq = input instanceof Request;
        const method = init?.method ?? (isReq ? input.method : "GET");
        if (method.toUpperCase() === "POST") {
          const reply: Message = {
            kind: "message",
            messageId: "r1",
            role: "agent",
            parts: [{ kind: "text", text: "sync reply" }],
            contextId: "C1:T1"
          };
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: reply }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify(card), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      })
    );
    void calls;

    const result = await acceptA2ARemote(
      { endpoint: ENDPOINT, authToken: "t" },
      userMessage("hi"),
      { url: "https://gw.example.com/a2a/notifications", token: "n" }
    );
    expect(result).toEqual({ kind: "contract_violation" });
  });
});

describe("sanitizeRemoteReply — untrusted reply hardening", () => {
  it("strips control characters and caps an oversized reply", () => {
    const hostile = "x".repeat(20_000) + "\u0007bell";
    const reply = sanitizeRemoteReply(hostile);
    expect(reply).not.toContain("\u0007");
    // 16_000 chars + the truncation ellipsis.
    expect(reply.length).toBe(16_001);
    expect(reply.endsWith("…")).toBe(true);
  });

  it("keeps tabs and newlines", () => {
    expect(sanitizeRemoteReply("a\tb\nc")).toBe("a\tb\nc");
  });

  it("defangs Slack broadcast sequences so a hostile reply can't @-notify a channel", () => {
    const reply = sanitizeRemoteReply(
      "urgent <!channel> and <!here> and <!subteam^S1|@grp> now"
    );
    expect(reply).not.toContain("<!");
    expect(reply).toContain("@channel");
    expect(reply).toContain("@here");
    expect(reply).toContain("@subteam^S1|@grp");
  });
});
