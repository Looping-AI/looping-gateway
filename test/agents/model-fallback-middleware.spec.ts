import { describe, it, expect } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { APICallError, generateText, wrapLanguageModel } from "ai";
import {
  fallbackMiddleware,
  servedByFallback
} from "@/agents/model-fallback-middleware";
import { normalizeToolInputMiddleware } from "@/agents/model-middleware";

// ---------------------------------------------------------------------------
// Helpers — raw provider-boundary shapes, which is the layer this middleware
// works at. `finishReason` is an object here, not the string the SDK surfaces.
// ---------------------------------------------------------------------------

// Widened rather than inferred: a literal `undefined` narrows the field to
// `undefined`, and the merged-usage case below reports real cache numbers.
const usage: {
  inputTokens: {
    total: number | undefined;
    noCache: number | undefined;
    cacheRead: number | undefined;
    cacheWrite: number | undefined;
  };
  outputTokens: {
    total: number | undefined;
    text: number | undefined;
    reasoning: number | undefined;
  };
} = {
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

  // The step result cannot report which model produced it: `generateText` fills
  // `response.modelId` from the model it was handed, which is this middleware's
  // wrapper. So the fallback marks its own work, and `[agent-turn]` counts the
  // marks. These two check the writer against the reader — the only place the
  // spelling of that mark is pinned.
  it("marks a result the fallback produced, and leaves the primary's unmarked", async () => {
    const primary = model("primary", async () => textResult("primary answer"));
    const fallback = model("fallback", async () => textResult("fallback"));

    expect(
      servedByFallback((await run(primary, fallback)).providerMetadata)
    ).toBe(false);

    const failing = throwingModel("primary", bindingError());
    expect(
      servedByFallback((await run(failing, fallback)).providerMetadata)
    ).toBe(true);
  });

  it("keeps provider metadata the fallback's own provider set", async () => {
    const primary = throwingModel("primary", bindingError());
    const fallback = model("fallback", async () => ({
      ...textResult("fallback answer"),
      providerMetadata: { workersai: { cacheStatus: "miss" } }
    }));

    const result = await run(primary, fallback);

    expect(servedByFallback(result.providerMetadata)).toBe(true);
    // A wrapper that overwrote the provider's own namespace would be throwing
    // away the only thing that knows what the provider actually did.
    expect(result.providerMetadata?.workersai).toEqual({ cacheStatus: "miss" });
  });

  it("reports the tokens both models spent when the primary narrated", async () => {
    // The primary succeeded and was billed; only its *answer* was rejected. If
    // the returned result carried the fallback's usage alone, `[agent-turn]`
    // would under-report exactly the turns that went wrong.
    const primary = model("primary", async () =>
      textResult("I did the thing.")
    );
    const fallback = model("fallback", async () => ({
      ...toolCallResult("final_reply"),
      usage: {
        inputTokens: {
          total: 10,
          noCache: 8,
          cacheRead: 2,
          cacheWrite: undefined
        },
        outputTokens: { total: 4, text: 4, reasoning: undefined }
      }
    }));

    const result = await run(primary, fallback, { type: "required" });

    // The shared `usage` fixture reports 1 in / 1 out for the primary.
    expect(result.usage.inputTokens.total).toBe(11);
    expect(result.usage.inputTokens.noCache).toBe(9);
    expect(result.usage.inputTokens.cacheRead).toBe(2);
    expect(result.usage.outputTokens.total).toBe(5);
  });

  it("does not invent usage for a primary that threw before reporting any", async () => {
    // Nothing was billed for a call that never returned, so the fallback's own
    // numbers stand unchanged.
    const primary = throwingModel("primary", bindingError());
    const fallback = model("fallback", async () =>
      textResult("fallback answer")
    );

    const result = await run(primary, fallback);

    expect(result.usage).toEqual(usage);
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

  it("lets a DOMException abort through — the shape AbortSignal actually throws", async () => {
    // Caught deliberately rather than with `rejects.toThrow`, which assumes an
    // Error: whether a DOMException is one is exactly what must not be assumed.
    const primary = throwingModel(
      "primary",
      new DOMException("the turn was cancelled", "AbortError")
    );
    const fallback = model("fallback", async () => textResult("unused"));

    const err: unknown = await run(primary, fallback).catch((e: unknown) => e);

    expect((err as { name?: string }).name).toBe("AbortError");
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
