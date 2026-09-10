import { describe, it, expect } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError, generateText, wrapLanguageModel } from "ai";
import { fallbackMiddleware } from "@/agents/model-fallback-middleware";
import { normalizeToolInputMiddleware } from "@/agents/model-middleware";

// ---------------------------------------------------------------------------
// Helpers — raw provider-boundary shapes, which is the layer this middleware
// works at. `finishReason` is an object here, not the string the SDK surfaces.
// ---------------------------------------------------------------------------

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined }
};

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage,
    warnings: []
  };
}

function toolCallResult(toolName: string, input = '{"ok":true}') {
  return {
    content: [
      { type: "tool-call" as const, toolCallId: "tc1", toolName, input }
    ],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage,
    warnings: []
  };
}

type Result = ReturnType<typeof textResult> | ReturnType<typeof toolCallResult>;

function model(modelId: string, doGenerate: () => Promise<Result>) {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: doGenerate as never
  });
}

function throwingModel(modelId: string, err: unknown) {
  return model(modelId, () => Promise.reject(err));
}

/** Drive `wrapGenerate` directly — no provider, no binding, no `generateText`. */
async function run(
  primary: MockLanguageModelV4,
  fallback: MockLanguageModelV4,
  toolChoice?:
    { type: "auto" | "required" } | { type: "tool"; toolName: string }
) {
  const params = {
    prompt: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hi" }]
      }
    ],
    ...(toolChoice ? { toolChoice } : {})
  };
  const wrapGenerate = fallbackMiddleware(fallback).wrapGenerate!;
  return await wrapGenerate({
    doGenerate: () => primary.doGenerate(params as never),
    doStream: () => {
      throw new Error("streaming is not wired through this middleware");
    },
    params: params as never,
    model: primary
  });
}

function textOf(result: { content: unknown[] }): string {
  return result.content
    .map((p) => p as { type: string; text?: string })
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
}

const bindingError = () =>
  new APICallError({
    message: "Capacity temporarily exceeded",
    url: "workers-ai:binding/run/@cf/test",
    requestBodyValues: {},
    statusCode: 429
  });

// ---------------------------------------------------------------------------

describe("fallbackMiddleware", () => {
  it("returns the primary's result and leaves the fallback alone", async () => {
    const primary = model("primary", async () => textResult("primary answer"));
    const fallback = model("fallback", async () => textResult("unused"));

    const result = await run(primary, fallback);

    expect(textOf(result)).toBe("primary answer");
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });

  it("uses the fallback when the primary throws, with the same params", async () => {
    const primary = throwingModel("primary", bindingError());
    const fallback = model("fallback", async () =>
      textResult("fallback answer")
    );

    const result = await run(primary, fallback);

    expect(textOf(result)).toBe("fallback answer");
    expect(fallback.doGenerateCalls).toHaveLength(1);
    expect(fallback.doGenerateCalls[0].prompt).toEqual(
      primary.doGenerateCalls[0].prompt
    );
  });

  it("lets an abort through untouched rather than spending the fallback on it", async () => {
    const aborted = new Error("the turn was cancelled");
    aborted.name = "AbortError";
    const primary = throwingModel("primary", aborted);
    const fallback = model("fallback", async () => textResult("unused"));

    await expect(run(primary, fallback)).rejects.toThrow(
      "the turn was cancelled"
    );
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });

  it("propagates the fallback's own failure when both models are down", async () => {
    const primary = throwingModel("primary", bindingError());
    const fallback = throwingModel(
      "fallback",
      new Error("fallback down as well")
    );

    await expect(run(primary, fallback)).rejects.toThrow(
      "fallback down as well"
    );
  });

  it("treats prose under toolChoice 'required' as a failure to answer", async () => {
    const primary = model("primary", async () =>
      textResult("I have updated the endpoint.")
    );
    const fallback = model("fallback", async () =>
      toolCallResult("final_reply")
    );

    const result = await run(primary, fallback, { type: "required" });

    expect(result.content[0]).toMatchObject({ type: "tool-call" });
    expect(fallback.doGenerateCalls).toHaveLength(1);
  });

  it("accepts any tool call under 'required'", async () => {
    const primary = model("primary", async () => toolCallResult("work"));
    const fallback = model("fallback", async () => textResult("unused"));

    await run(primary, fallback, { type: "required" });

    expect(fallback.doGenerateCalls).toHaveLength(0);
  });

  it("falls back when a forced tool is answered with a different one", async () => {
    const primary = model("primary", async () => toolCallResult("work"));
    const fallback = model("fallback", async () =>
      toolCallResult("final_reply")
    );

    await run(primary, fallback, { type: "tool", toolName: "final_reply" });

    expect(fallback.doGenerateCalls).toHaveLength(1);
  });

  it("accepts a forced tool call whose input is malformed", async () => {
    // The same test the SDK applies: the constraint is about *which* tool was
    // called, not whether its arguments parse. A malformed call is the repair
    // loop's problem, and a second model would not know any better.
    const primary = model("primary", async () =>
      toolCallResult("final_reply", "{not json")
    );
    const fallback = model("fallback", async () => textResult("unused"));

    await run(primary, fallback, { type: "tool", toolName: "final_reply" });

    expect(fallback.doGenerateCalls).toHaveLength(0);
  });

  it("returns the fallback's answer even when it narrates too", async () => {
    // One fallback per call, no second guess. `generateText` raises the violation
    // itself a moment later, and the turn ends in its forced final round.
    const primary = model("primary", async () => textResult("prose one"));
    const fallback = model("fallback", async () => textResult("prose two"));

    const result = await run(primary, fallback, { type: "required" });

    expect(textOf(result)).toBe("prose two");
  });

  it("hands the fallback params the normalizer has already repaired", async () => {
    // Middleware order is load-bearing: `normalizeToolInputMiddleware` is declared
    // first, so it is outermost, and the fallback inherits its repair instead of
    // needing a wrapper of its own.
    const primary = throwingModel("primary", bindingError());
    const fallback = model("fallback", async () => textResult("recovered"));
    const wrapped = wrapLanguageModel({
      model: primary,
      middleware: [normalizeToolInputMiddleware, fallbackMiddleware(fallback)]
    });

    const result = await generateText({
      model: wrapped,
      telemetry: { isEnabled: false },
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "set_context",
              // Double-encoded, the shape a capped history record replays as.
              input: JSON.stringify({ label: "memory" })
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc1",
              toolName: "set_context",
              output: { type: "text", value: "ok" }
            }
          ]
        }
      ]
    });

    expect(result.text).toBe("recovered");
    const assistant = fallback.doGenerateCalls[0].prompt.find(
      (m) => m.role === "assistant"
    );
    expect(assistant?.content[0]).toMatchObject({
      type: "tool-call",
      input: { label: "memory" }
    });
  });
});
