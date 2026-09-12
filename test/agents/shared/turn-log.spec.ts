import { describe, it, expect, vi } from "vitest";
import type { LanguageModelUsage } from "ai";
import { startTurnLog, type GenerationLike } from "@/agents/shared/turn-log";

/**
 * The one line a turn leaves behind.
 *
 * What is checked here is the arithmetic — summing two generations, counting
 * fallback-served steps, keeping "the provider said nothing" distinct from "the
 * provider said zero". That the *shape* matches a real `generateText` result is
 * checked by the compiler at the `loop.ts` call site, and that a turn emits
 * exactly one of these is checked in `loop.spec.ts`.
 */

const identity = {
  contextId: "C1:1700000000.0001",
  taskId: "task-1",
  tenant: "admin",
  workspaceId: 7,
  user: "U123",
  model: "@cf/zai-org/glm-5.2"
};

/** The spelling `model-fallback-middleware.ts` writes. Pinned by its own spec. */
const FALLBACK_SERVED = { "slack-gatekeeper": { servedByFallback: true } };

function usage(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  cacheReadTokens?: number
): LanguageModelUsage {
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens,
      cacheWriteTokens: undefined
    },
    outputTokens,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: undefined
  };
}

function step({
  tools = [],
  responseTimeMs = 0,
  toolExecutionMs = {},
  fallback = false
}: {
  tools?: string[];
  responseTimeMs?: number;
  toolExecutionMs?: Record<string, number>;
  fallback?: boolean;
} = {}): GenerationLike["steps"][number] {
  return {
    performance: { responseTimeMs, toolExecutionMs },
    providerMetadata: fallback ? FALLBACK_SERVED : undefined,
    content: tools.map((toolName) => ({ type: "tool-call", toolName }))
  };
}

/** Run a turn log and return the object it logged. */
function emitted(build: (log: ReturnType<typeof startTurnLog>) => void) {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const log = startTurnLog(identity);
    build(log);
    log.flush();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toBe("[agent-turn]");
    return info.mock.calls[0]?.[1] as Record<string, unknown>;
  } finally {
    info.mockRestore();
  }
}

describe("the turn log", () => {
  it("carries the turn's identity even when nothing ran", () => {
    const line = emitted(() => {});

    expect(line).toMatchObject({ ...identity, generations: 0, steps: 0 });
    // No exit claimed the turn, which from here is indistinguishable from a
    // throw — and is exactly what a throw leaves behind.
    expect(line.ending).toBe("failed");
  });

  it("sums tokens, timings and tool calls across every step", () => {
    const line = emitted((log) => {
      log.add({
        steps: [
          step({
            tools: ["agents_read"],
            responseTimeMs: 100,
            toolExecutionMs: { a: 5 }
          }),
          step({
            tools: ["agents_read", "final_reply"],
            responseTimeMs: 200,
            toolExecutionMs: { b: 7, c: 3 }
          })
        ],
        usage: usage(1000, 50, 400),
        finishReason: "stop"
      });
      log.ending("reply");
    });

    expect(line).toMatchObject({
      ending: "reply",
      generations: 1,
      steps: 2,
      fallbacks: 0,
      finishReason: "stop",
      modelMs: 300,
      toolMs: 15,
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 50,
      // Counted, not listed: the same tool twice is the signal that a turn is
      // going in circles, and a flat list of names hides it.
      tools: { agents_read: 2, final_reply: 1 }
    });
  });

  it("folds a salvaged ending into the same line", () => {
    const line = emitted((log) => {
      log.add({
        steps: [step({ responseTimeMs: 10 })],
        usage: usage(100, 5),
        finishReason: "tool-calls"
      });
      log.add({
        steps: [step({ tools: ["final_reply"], responseTimeMs: 20 })],
        usage: usage(200, 9),
        finishReason: "stop"
      });
      log.ending("reply");
    });

    expect(line).toMatchObject({
      generations: 2,
      steps: 2,
      modelMs: 30,
      inputTokens: 300,
      outputTokens: 14,
      // The salvage's, not the first attempt's: a salvage runs only because the
      // first left no answer, so its reason is the one that explains the turn.
      finishReason: "stop"
    });
  });

  it("counts the steps the fallback model served", () => {
    const line = emitted((log) => {
      log.add({
        steps: [step(), step({ fallback: true }), step({ fallback: true })],
        usage: usage(1, 1),
        finishReason: "stop"
      });
      log.ending("reply");
    });

    expect(line).toMatchObject({ steps: 3, fallbacks: 2 });
  });

  it("keeps an unreported token count out of the sum", () => {
    // A provider that went quiet and a model that used nothing are different
    // facts. Folding the first into 0 would understate the turn and, worse, make
    // the understatement invisible.
    const line = emitted((log) => {
      log.add({
        steps: [step()],
        usage: usage(undefined, undefined),
        finishReason: "stop"
      });
      log.ending("reply");
    });

    expect(line.inputTokens).toBeUndefined();
    expect(line.outputTokens).toBeUndefined();
    expect(line.cachedInputTokens).toBeUndefined();
  });

  it("adds a reported count to an unreported one without losing it", () => {
    const line = emitted((log) => {
      log.add({
        steps: [step()],
        usage: usage(undefined, undefined),
        finishReason: "stop"
      });
      log.add({
        steps: [step()],
        usage: usage(42, 7),
        finishReason: "stop"
      });
      log.ending("reply");
    });

    expect(line).toMatchObject({ inputTokens: 42, outputTokens: 7 });
  });

  it("emits once however many times it is flushed", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = startTurnLog(identity);

    log.flush();
    log.flush();

    expect(info).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });
});
