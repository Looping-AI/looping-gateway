import { createWorkersAI } from "workers-ai-provider";
import {
  customProvider,
  wrapLanguageModel,
  type EmbeddingModel,
  type LanguageModel
} from "ai";
import { env } from "cloudflare:workers";
import { normalizeToolInputMiddleware } from "@/agents/model-middleware";
import { fallbackMiddleware } from "@/agents/model-fallback-middleware";
import {
  AI_GATEWAY_ID,
  CHAT_MODEL_ID,
  CHAT_FALLBACK_MODEL_ID,
  CHAT_REASONING_EFFORT,
  EMBED_MAX_PER_CALL,
  EMBED_MODEL_ID
} from "@/config";

/**
 * Options every chat call carries, in one place because they must not drift: the
 * tool loop and the Sessions compaction summarizer are two call sites of the same
 * model, and a setting applied to only one of them fails silently.
 *
 * `reasoning` is the SDK's unified option; the provider maps it to Workers AI's
 * `reasoning_effort`. Telemetry is off because on workerd its tracing span leaves a
 * duplicate of every rejection unhandled (see `shared/loop.ts`).
 */
export const CHAT_CALL_OPTIONS = {
  reasoning: CHAT_REASONING_EFFORT,
  telemetry: { isEnabled: false }
} as const;

/** Test seam. The fallback is the model's own business now, not the caller's. */
export interface ModelOverrides {
  model?: LanguageModel;
}

function buildProvider() {
  const workersai = createWorkersAI({
    binding: env.AI,
    gateway: { id: AI_GATEWAY_ID }
  });
  return customProvider({
    languageModels: {
      chat: wrapLanguageModel({
        model: workersai(CHAT_MODEL_ID),
        // Order matters: the first entry is the outermost. History is repaired
        // before the fallback is handed the same params, so the fallback model
        // needs no wrapper of its own — a shape the primary refused is one it
        // would refuse a moment later.
        middleware: [
          normalizeToolInputMiddleware,
          fallbackMiddleware(workersai(CHAT_FALLBACK_MODEL_ID))
        ]
      })
    },
    embeddingModels: {
      // `supportsParallelCalls: false` is what keeps `embedMany` sequential: it
      // overrides the caller's `maxParallelCalls` outright, so one archive cannot
      // fan out across concurrent binding calls.
      embed: workersai.textEmbeddingModel(EMBED_MODEL_ID, {
        maxEmbeddingsPerCall: EMBED_MAX_PER_CALL,
        supportsParallelCalls: false
      })
    }
    // No `fallbackProvider`: these two ids are the only ones this provider serves,
    // and an unknown one should throw rather than be forwarded somewhere.
  });
}

let provider: ReturnType<typeof buildProvider> | undefined;

/**
 * Built once per isolate, on first use. `env.AI` is deliberately never read at
 * module scope — the binding is not there until the isolate is initialized.
 */
function agentProvider() {
  return (provider ??= buildProvider());
}

/** The model used by the agent tool loop and the Sessions compaction summarizer. */
export function chatModel(overrides: ModelOverrides = {}): LanguageModel {
  return overrides.model ?? agentProvider().languageModel("chat");
}

/** The model episodic recall embeds with. */
export function embeddingModel(): EmbeddingModel {
  return agentProvider().embeddingModel("embed");
}
