import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";
import { env } from "cloudflare:workers";
import {
  AI_GATEWAY_ID,
  CHAT_MODEL_ID,
  CHAT_FALLBACK_MODEL_ID,
  CHAT_REASONING_EFFORT
} from "@/config";

/**
 * Settings both chat models are built with. `reasoning_effort` is forwarded by
 * the provider on the `inputs` of `binding.run` — see {@link CHAT_REASONING_EFFORT}
 * for why it is set at all, and why it is set here rather than per call.
 */
const CHAT_SETTINGS = { reasoning_effort: CHAT_REASONING_EFFORT } as const;

/** The model used by the agent tool loop and the Sessions compaction summarizer. */
export function chatModel(): LanguageModel {
  const workersai = createWorkersAI({
    binding: env.AI,
    gateway: { id: AI_GATEWAY_ID }
  });
  return workersai(CHAT_MODEL_ID, CHAT_SETTINGS);
}

/** Fallback model used when the primary model is over capacity. */
export function fallbackChatModel(): LanguageModel {
  const workersai = createWorkersAI({
    binding: env.AI,
    gateway: { id: AI_GATEWAY_ID }
  });
  return workersai(CHAT_FALLBACK_MODEL_ID, CHAT_SETTINGS);
}

export interface ModelOverrides {
  model?: LanguageModel; // test override for the primary
  fallbackModel?: LanguageModel; // test override for the fallback
}

/** The primary/fallback models (lazily memoized) plus their ids for logging. */
export interface ModelPair {
  primary: () => LanguageModel;
  fallback: () => LanguageModel;
  primaryId: () => string;
  fallbackId: () => string;
}

/** Lazily build + memoize the primary/fallback model pair (being used in tests). */
export function createModelPair(overrides: ModelOverrides = {}): ModelPair {
  let primary: LanguageModel | undefined;
  let fallback: LanguageModel | undefined;
  return {
    primary: () => (primary ??= overrides.model ?? chatModel()),
    fallback: () =>
      (fallback ??=
        overrides.fallbackModel ?? overrides.model ?? fallbackChatModel()),
    primaryId: () => CHAT_MODEL_ID,
    fallbackId: () => CHAT_FALLBACK_MODEL_ID
  };
}
