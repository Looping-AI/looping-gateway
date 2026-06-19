import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";
import type { ModelPair } from "@/agents/model";
import type { SessionLike } from "@/agents/shared/session";
import {
  isTransientAiError,
  executeAgentTurn,
  type AgentTurnConfig
} from "@/agents/shared/loop";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okResult(text: string) {
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

function lengthResult(text: string) {
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

class FakeSession implements SessionLike {
  messages: SessionMessage[] = [];
  appendSpy = vi.fn(async (m: SessionMessage) => {
    this.messages.push(m);
  });
  async appendMessage(m: SessionMessage) {
    return this.appendSpy(m);
  }
  async getHistory() {
    return this.messages;
  }
  async refreshSystemPrompt() {
    return "SYSTEM";
  }
  async tools() {
    return {};
  }
  async getCompactions() {
    return [];
  }
}

function fakeEventBus() {
  const published: Array<{ parts: Array<{ text?: string }> }> = [];
  const publish = vi.fn((e: unknown) => {
    published.push(e as never);
  });
  const finished = vi.fn();
  const eventBus = { publish, finished } as never;
  return { eventBus, published, publish, finished };
}

function fakeRequestContext(text = "hello") {
  return {
    contextId: "ctx-1",
    userMessage: {
      kind: "message",
      messageId: "m1",
      role: "user",
      parts: [{ kind: "text", text }],
      metadata: {}
    }
  } as never;
}

function fakeModels(
  primary: LanguageModel,
  fallback: LanguageModel = primary
): ModelPair {
  return {
    primary: () => primary,
    fallback: () => fallback,
    primaryId: () => "primary-model",
    fallbackId: () => "fallback-model"
  };
}

function makeCfg(
  session: SessionLike,
  models: ModelPair,
  overrides: Partial<AgentTurnConfig> = {}
): AgentTurnConfig {
  return {
    models,
    prepare: async () => ({ session, systemSuffix: "", tools: {} }),
    unexpectedReply: "Something went wrong. Please try again.",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// isTransientAiError
// ---------------------------------------------------------------------------

describe("isTransientAiError", () => {
  it("returns false for non-Error values", () => {
    expect(isTransientAiError("string error")).toBe(false);
    expect(isTransientAiError(42)).toBe(false);
    expect(isTransientAiError(null)).toBe(false);
    expect(isTransientAiError(undefined)).toBe(false);
  });

  it("returns true when message contains error code 3040", () => {
    expect(isTransientAiError(new Error("error code 3040 hit"))).toBe(true);
  });

  it("returns true when message contains error code 3046", () => {
    expect(isTransientAiError(new Error("3046 returned from model"))).toBe(
      true
    );
  });

  it("returns true for 'capacity temporarily exceeded' (case-insensitive)", () => {
    expect(isTransientAiError(new Error("Capacity Temporarily Exceeded"))).toBe(
      true
    );
    expect(isTransientAiError(new Error("CAPACITY TEMPORARILY EXCEEDED"))).toBe(
      true
    );
  });

  it("returns true for 'request timeout' (case-insensitive)", () => {
    expect(isTransientAiError(new Error("Request Timeout occurred"))).toBe(
      true
    );
    expect(isTransientAiError(new Error("REQUEST TIMEOUT"))).toBe(true);
  });

  it("returns false for an unrelated error message", () => {
    expect(isTransientAiError(new Error("some unrelated failure"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeAgentTurn
// ---------------------------------------------------------------------------

describe("executeAgentTurn", () => {
  it("happy path: appends user + assistant messages and publishes the reply", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("Hello!") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, fakeModels(model))
    );

    // finished() always fires
    expect(bus.finished).toHaveBeenCalledTimes(1);
    // One published reply with the model's text
    expect(bus.published).toHaveLength(1);
    expect(bus.published[0].parts[0]).toMatchObject({ text: "Hello!" });
    // User turn then assistant turn persisted
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("falls back to the fallback model when the primary throws", async () => {
    const session = new FakeSession();
    const fallbackModel = new MockLanguageModelV3({
      doGenerate: async () => okResult("Fallback reply") as never
    });
    const bus = fakeEventBus();

    // Make primary() itself throw synchronously — exercises the inner catch that
    // retries with fallback() without passing a throwing model to generateText
    // (which would leak an unhandled rejection through the SDK telemetry span).
    const models: ModelPair = {
      primary: () => {
        throw new Error("primary unavailable");
      },
      fallback: () => fallbackModel,
      primaryId: () => "primary-model",
      fallbackId: () => "fallback-model"
    };

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, models)
    );

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(bus.published[0].parts[0]).toMatchObject({ text: "Fallback reply" });
  });

  it("publishes the transient reply when a transient error propagates to the outer catch", async () => {
    // Inject the transient error through prepare() to test the outer catch's
    // isTransientAiError branch without invoking generateText (which leaks
    // unhandled rejections through the telemetry span in the Workers runtime).
    const bus = fakeEventBus();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("unused") as never
    });

    await executeAgentTurn(fakeRequestContext("hi"), bus.eventBus, {
      models: fakeModels(model),
      prepare: async () => {
        throw new Error("capacity temporarily exceeded");
      },
      unexpectedReply: "Something went wrong. Please try again."
    });

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(bus.published).toHaveLength(1);
    expect(bus.published[0].parts[0].text).toMatch(/temporarily unavailable/i);
  });

  it("publishes unexpectedReply when a non-transient error propagates to the outer catch", async () => {
    // Same injection strategy as the transient test above — prepare() throw
    // exercises the same outer-catch branch, just the non-transient arm.
    const bus = fakeEventBus();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("unused") as never
    });

    await executeAgentTurn(fakeRequestContext("hi"), bus.eventBus, {
      models: fakeModels(model),
      prepare: async () => {
        throw new Error("some unexpected failure");
      },
      unexpectedReply: "Something went wrong. Please try again."
    });

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(bus.published).toHaveLength(1);
    expect(bus.published[0].parts[0].text).toBe(
      "Something went wrong. Please try again."
    );
  });

  it("publishes the transient reply and skips persist when model returns empty text", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("   ") as never // whitespace-only → trims to ""
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, fakeModels(model))
    );

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(bus.published[0].parts[0].text).toMatch(/temporarily unavailable/i);
    // User message WAS appended; assistant message was NOT (empty reply skipped)
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("publishes the transient reply and skips persist when finish_reason is 'length'", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => lengthResult("truncated content here") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, fakeModels(model))
    );

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(bus.published[0].parts[0].text).toMatch(/temporarily unavailable/i);
    // Assistant message must NOT be persisted when the reply was truncated
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("publishes unexpectedReply and still finishes when prepare() throws", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("unused") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(fakeRequestContext(), bus.eventBus, {
      models: fakeModels(model),
      prepare: async () => {
        throw new Error("missing metadata");
      },
      unexpectedReply: "Something went wrong. Please try again."
    });

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(bus.published).toHaveLength(1);
    expect(bus.published[0].parts[0].text).toBe(
      "Something went wrong. Please try again."
    );
  });

  it("always calls finished() even when the second appendMessage throws", async () => {
    const session = new FakeSession();
    // Let the first appendMessage (user turn) succeed, fail on the second (assistant turn).
    session.appendSpy
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("SQL error"));

    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("Hi") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext(),
      bus.eventBus,
      makeCfg(session, fakeModels(model))
    );

    expect(bus.finished).toHaveBeenCalledTimes(1);
  });
});
