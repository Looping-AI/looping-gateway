import { vi } from "vitest";
import { env } from "cloudflare:workers";
import type { SessionMessage } from "agents/experimental/memory/session";
import type { SessionLike } from "@/agents/shared/session";

/**
 * In-memory `SessionLike` for driving agent executors without a Durable Object.
 * `appendSpy` lets tests assert on persisted messages; `compactions` seeds
 * `getCompactions` (non-empty ⇒ the executor treats an episodic archive as present).
 */
export class FakeSession implements SessionLike {
  messages: SessionMessage[] = [];
  appendSpy = vi.fn(async (m: SessionMessage) => {
    this.messages.push(m);
  });
  constructor(private compactions: unknown[] = []) {}
  async appendMessage(m: SessionMessage) {
    return this.appendSpy(m);
  }
  async getHistory() {
    return this.messages;
  }
  async refreshSystemPrompt() {
    return "SYSTEM PROMPT";
  }
  async tools() {
    return {};
  }
  async getCompactions() {
    return this.compactions;
  }
}

/** Spread real env but replace AI + VECTORIZE with spies (no network needed). */
export function fakeRecallEnv() {
  const run = vi.fn(async () => ({ data: [Array(1024).fill(0.1)] }));
  // Typed at the type level (not via named params) so `query.mock.calls[0][1]`
  // — the options object the executor passes — stays inspectable in assertions.
  const query = vi.fn<
    (
      vector: number[],
      opts: unknown
    ) => Promise<{ count: number; matches: unknown[] }>
  >(async () => ({ count: 0, matches: [] }));
  return {
    env: { ...env, AI: { run }, VECTORIZE: { query } } as unknown as Env,
    run,
    query
  };
}

// Minimal valid LanguageModelV3 generate result.
export function okResult(text: string) {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop" },
    usage: {
      inputTokens: { total: 1, noCache: 1 },
      outputTokens: { total: 1 },
      totalTokens: 2
    },
    warnings: []
  };
}

/** Like `okResult` but signals the model hit its output-length cap. */
export function lengthResult(text: string) {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "length" },
    usage: {
      inputTokens: { total: 1, noCache: 1 },
      outputTokens: { total: 1 },
      totalTokens: 2
    },
    warnings: []
  };
}

export function toolCallResult(toolName: string, input: unknown) {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: "tc1",
        toolName,
        input: JSON.stringify(input)
      }
    ],
    finishReason: { unified: "tool-calls" },
    usage: {
      inputTokens: { total: 1, noCache: 1 },
      outputTokens: { total: 1 },
      totalTokens: 2
    },
    warnings: []
  };
}

/** A one-turn agent request plus a capturing event bus, shared by executor specs. */
export function makeRequest(opts: {
  contextId: string;
  text: string;
  metadata: Record<string, unknown>;
}) {
  const published: Array<{ parts: Array<{ text?: string }> }> = [];
  let finished = false;
  const eventBus = {
    publish: (e: unknown) => published.push(e as never),
    finished: () => {
      finished = true;
    }
  };
  const requestContext = {
    contextId: opts.contextId,
    userMessage: {
      kind: "message",
      messageId: "m1",
      role: "user",
      parts: [{ kind: "text", text: opts.text }],
      metadata: opts.metadata
    }
  };
  return {
    published,
    isFinished: () => finished,
    // Cast at the boundary — we only exercise the fields the executor reads.
    eventBus: eventBus as never,
    requestContext: requestContext as never
  };
}
