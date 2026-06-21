import { describe, it, expect, afterEach, vi } from "vitest";
import type { Message } from "@a2a-js/sdk";
import { sendA2AMessage } from "@/a2a/client";
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
}

/**
 * Stub global fetch as a fake remote A2A server:
 *  - GET  → the agent card (so the client's discovery succeeds),
 *  - POST → a JSON-RPC reply whose text we control (to exercise sanitizing).
 * Records every call so we can assert the injected Bearer header.
 */
function stubRemote(replyText: string, calls: Captured[]) {
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
      calls.push({ url, method, authorization: headers.get("authorization") });

      if (method.toUpperCase() === "POST") {
        const raw = isReq
          ? await input.clone().text()
          : String(init?.body ?? "");
        let id: unknown = 1;
        try {
          id = JSON.parse(raw).id ?? 1;
        } catch {
          /* ignore */
        }
        const reply: Message = {
          kind: "message",
          messageId: "r1",
          role: "agent",
          parts: [{ kind: "text", text: replyText }],
          contextId: "C1:T1"
        };
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id, result: reply }),
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

describe("sendA2AMessage — remote target", () => {
  it("injects the gateway JWT as a Bearer header on the JSON-RPC call", async () => {
    const calls: Captured[] = [];
    stubRemote("ok", calls);

    await sendA2AMessage(
      { kind: "remote", endpoint: ENDPOINT, authToken: "tok-123" },
      userMessage("hi")
    );

    const post = calls.find((c) => c.method.toUpperCase() === "POST");
    expect(post).toBeDefined();
    expect(post?.authorization).toBe("Bearer tok-123");
  });

  it("strips control characters and caps an oversized remote reply", async () => {
    const calls: Captured[] = [];
    // 20k visible chars + a bell control char that must be stripped.
    const hostile = "x".repeat(20_000) + "\u0007bell";
    stubRemote(hostile, calls);

    const reply = await sendA2AMessage(
      { kind: "remote", endpoint: ENDPOINT, authToken: "t" },
      userMessage("hi")
    );

    expect(reply).not.toContain("\u0007");
    // 16_000 chars + the truncation ellipsis.
    expect(reply.length).toBe(16_001);
    expect(reply.endsWith("…")).toBe(true);
  });
});
