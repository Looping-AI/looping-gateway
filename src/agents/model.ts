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
