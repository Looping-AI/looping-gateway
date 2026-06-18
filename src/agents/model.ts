import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";
import { AI_GATEWAY_ID, CHAT_MODEL_ID, CHAT_FALLBACK_MODEL_ID } from "@/config";

/** The model used by the agent tool loop and the Sessions compaction summarizer. */
export function chatModel(env: Env): LanguageModel {
  const workersai = createWorkersAI({
    binding: env.AI,
    gateway: { id: AI_GATEWAY_ID }
  });
  return workersai(CHAT_MODEL_ID);
}

/** Fallback model used when the primary model is over capacity. */
export function fallbackChatModel(env: Env): LanguageModel {
  const workersai = createWorkersAI({
    binding: env.AI,
    gateway: { id: AI_GATEWAY_ID }
  });
  return workersai(CHAT_FALLBACK_MODEL_ID);
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
export function createModelPair(
  env: Env,
  overrides: ModelOverrides = {}
): ModelPair {
  let primary: LanguageModel | undefined;
  let fallback: LanguageModel | undefined;
  return {
    primary: () => (primary ??= overrides.model ?? chatModel(env)),
    fallback: () =>
      (fallback ??=
        overrides.fallbackModel ?? overrides.model ?? fallbackChatModel(env)),
    primaryId: () => CHAT_MODEL_ID,
    fallbackId: () => CHAT_FALLBACK_MODEL_ID
  };
}
