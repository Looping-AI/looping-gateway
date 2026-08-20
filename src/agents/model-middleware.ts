import type { LanguageModelMiddleware } from "ai";
import { isRecord, jsonOf } from "@/util/json";

/**
 * Guard the one invariant every provider assumes and none of them state: a
 * replayed tool call's `input` is an **object**.
 *
 * `arguments` on a tool call is a JSON object by contract, and providers
 * re-serialize a replayed call as `arguments: JSON.stringify(input)`. Hand that a
 * string and the string is what the model receives — Workers AI rejects it outright
 * on `glm-5.2` ("Assistant tool call function.arguments must be a JSON object") and
 * crashes rendering it on `glm-4.7-flash` (`'str object' has no attribute 'items'`,
 * the chat template calling `.items()` on a `str`).
 *
 * Three things upstream can put a non-object there, and only the first is ours to
 * fix at the source:
 *
 *  1. A recorded call capped past the size ceiling — fixed in `capInput`
 *     ({@link file://./shared/messages.ts messages.ts}), but records written before
 *     that fix are durable and replay on every later turn.
 *  2. A tool call the SDK could not parse, which it hands back as the raw arguments
 *     string (`invalid: true`) and then replays into its own next step.
 *  3. `repairExchange` ({@link file://./shared/loop.ts loop.ts}) echoing a rejected
 *     `final_reply` call back to the model so it can fix it.
 *
 * A middleware catches all three at the last boundary before serialization, which
 * is also the only place that can repair history already sitting in a Session. It
 * warns rather than repairing silently: a poisoned record should stay visible in
 * the logs until it ages out of history.
 */

type TransformParams = NonNullable<LanguageModelMiddleware["transformParams"]>;
type CallOptions = Parameters<TransformParams>[0]["params"];
type PromptMessage = CallOptions["prompt"][number];

/**
 * Coerce one tool call's arguments back to an object.
 *
 * A string that parses to an object *is* the original arguments, double-encoded —
 * that is the exact shape a capped record replays as, and parsing recovers it
 * whole. Anything else (truncated JSON, a bare scalar) cannot be recovered, so it
 * is wrapped: the text stays readable to the model, and the wire shape is valid.
 */
function asArgumentsObject(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON at all — fall through to the wrapper.
    }
    return { _raw: input };
  }
  // `jsonOf`, not `JSON.stringify`: this is the last guard before the provider, so
  // it has to survive whatever it is handed. A cycle or a BigInt throwing here
  // would turn a repairable message into the crash the middleware exists to
  // prevent, and `undefined` would silently drop the key.
  return { _raw: jsonOf(input) };
}

export const normalizeToolInputMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    const repaired: string[] = [];

    const prompt = params.prompt.map((message): PromptMessage => {
      if (message.role !== "assistant") return message;
      let changed = false;
      const content = message.content.map((part) => {
        if (part.type !== "tool-call" || isRecord(part.input)) return part;
        changed = true;
        repaired.push(part.toolName);
        return { ...part, input: asArgumentsObject(part.input) };
      });
      return changed ? { ...message, content } : message;
    });

    if (repaired.length === 0) return params;
    console.warn("[model] repaired non-object tool-call arguments in history", {
      count: repaired.length,
      tools: [...new Set(repaired)]
    });
    return { ...params, prompt };
  }
};
