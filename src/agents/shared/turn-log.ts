import type { LanguageModelUsage, ProviderMetadata } from "ai";
import { servedByFallback } from "@/agents/model-fallback-middleware";

/**
 * One structured line per turn, so what a turn cost is a thing you can read.
 *
 * Until this existed the agent loop logged only anomalies — a stop, a violation,
 * a turn with no reply — which makes every rate it reports a numerator with no
 * denominator. Nothing read `result.usage` at all, so tokens, latency and step
 * count left no trace on our side; the only record was the AI Gateway log, which
 * carries no idea which Slack thread it belonged to.
 *
 * **One line, not one per step.** `wrangler.jsonc` sets no `head_sampling_rate`,
 * so everything logged is kept and paid for, and a ten-step turn writing ten
 * lines buries the one line that says how it ended. Per-step timings survive as
 * sums; the individual steps are on the gateway side if anyone needs them.
 *
 * The counterpart is the gateway metadata in {@link file://../model.ts model.ts}:
 * the same `contextId` is attached to every model call this turn makes, so a row
 * in `npm run cf -- ai` and a line in `npm run cf -- logs` can be put side by
 * side. `taskId` is here and not there because the gateway caps custom metadata
 * at five entries and this side has no cap at all.
 */

/**
 * How a turn ended, from the caller's point of view rather than the model's.
 *
 * `finishReason` answers why *generation* stopped, which is a different question
 * — a turn can finish for the best of reasons and still deliver nothing. These
 * are the five exits `executeAgentTurn` actually has.
 */
export type TurnEnding =
  /** A reply was published. */
  | "reply"
  /** Parked on a human: a question asked, or a destructive call awaiting Approve. */
  | "parked"
  /** A 🛑 landed; whatever was produced was withheld. */
  | "stopped"
  /** Generation finished but produced no answer; the user got the apology. */
  | "none"
  /** The turn threw. `[agent-loop] turn failed` carries the error itself. */
  | "failed";

/** Who and what a turn belongs to. Everything here is known before the model runs. */
export interface TurnIdentity {
  contextId: string;
  taskId: string;
  /** `"admin"`, `"onboarding"`, or a remote agent's tenant id. */
  tenant?: string;
  workspaceId?: number;
  /** The Slack user whose message opened the turn. */
  user?: string;
  /** The primary model id, which is what was *asked for* — see `fallbacks`. */
  model: string;
}

/** Accumulates a turn's observations; {@link TurnLog.flush} emits the one line. */
export interface TurnLog {
  /** Fold in a finished generation. A salvaged ending is a second one. */
  add(result: GenerationLike): void;
  /** Record how the turn ended. Unset means it threw. */
  ending(ending: TurnEnding): void;
  /** Emit. Safe to call once; later calls are ignored. */
  flush(): void;
}

/**
 * The part of a `generateText` result this reads.
 *
 * Structural rather than `GenerateTextResult<…>`, which is generic over the tool
 * set, the runtime context and the output type — three parameters this has no
 * opinion about. A real result still has to satisfy it, so a field renamed
 * upstream fails at the call site in `loop.ts` rather than here, and a spec can
 * build one without standing up a whole generation.
 */
export interface GenerationLike {
  readonly steps: readonly StepLike[];
  readonly usage: LanguageModelUsage;
  readonly finishReason: string;
}

/**
 * Narrowed to the fields that are read, not `Pick`ed from `StepResult`:
 * `StepResultPerformance` carries a dozen streaming-only timings this ignores,
 * and requiring them would make every fixture mostly filler.
 */
interface StepLike {
  readonly performance: {
    readonly responseTimeMs: number;
    readonly toolExecutionMs: Readonly<Record<string, number>>;
  };
  readonly providerMetadata: ProviderMetadata | undefined;
  readonly content: readonly { readonly type: string }[];
}

/** Names of the tools a step called, in call order. */
function toolNamesOf(step: StepLike): string[] {
  return step.content
    .filter(
      (part): part is { type: "tool-call"; toolName: string } =>
        part.type === "tool-call"
    )
    .map((part) => part.toolName);
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/**
 * Add two token counts, keeping `undefined` distinct from `0`.
 *
 * A model that reported nothing and a model that used nothing are different
 * facts, and rounding the first to zero would quietly understate a turn whose
 * provider went quiet. Only once both sides are absent does the total stay absent.
 */
function addTokens(
  a: number | undefined,
  b: number | undefined
): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

export function startTurnLog(identity: TurnIdentity): TurnLog {
  const startedAt = Date.now();
  const tools: Record<string, number> = {};
  let generations = 0;
  let steps = 0;
  let fallbacks = 0;
  let modelMs = 0;
  let toolMs = 0;
  let inputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let outputTokens: number | undefined;
  let finishReason: string | undefined;
  let ending: TurnEnding | undefined;
  let flushed = false;

  return {
    add(result) {
      generations += 1;
      steps += result.steps.length;
      // The last generation's reason is the turn's: a salvage runs only after the
      // first left no answer, so its ending is the one that counts.
      finishReason = result.finishReason;
      inputTokens = addTokens(inputTokens, result.usage.inputTokens);
      cachedInputTokens = addTokens(
        cachedInputTokens,
        result.usage.inputTokenDetails.cacheReadTokens
      );
      outputTokens = addTokens(outputTokens, result.usage.outputTokens);
      for (const step of result.steps) {
        if (servedByFallback(step.providerMetadata)) fallbacks += 1;
        modelMs += step.performance.responseTimeMs;
        toolMs += sum(Object.values(step.performance.toolExecutionMs));
        for (const name of toolNamesOf(step)) {
          tools[name] = (tools[name] ?? 0) + 1;
        }
      }
    },

    ending(next) {
      ending = next;
    },

    flush() {
      if (flushed) return;
      flushed = true;
      console.info("[agent-turn]", {
        ...identity,
        // Absent means `flush` ran from the `finally` without any exit having
        // claimed the turn, which is what a throw looks like from here.
        ending: ending ?? "failed",
        generations,
        steps,
        fallbacks,
        finishReason,
        ms: Date.now() - startedAt,
        modelMs,
        toolMs,
        inputTokens,
        cachedInputTokens,
        // Not `outputTokenDetails.reasoningTokens`: GLM reasons and bills for it,
        // but `workers-ai-provider` leaves that field undefined on every response
        // (`map-workersai-usage.ts`), so logging it would promise a number that is
        // never there. Reasoning is inside `outputTokens`, unseparated.
        outputTokens,
        tools
      });
    }
  };
}
