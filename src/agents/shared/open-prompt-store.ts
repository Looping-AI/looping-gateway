import { HITL_REQUEST_TTL_SECONDS } from "@/config";
import type { OpenPrompt, OpenPromptStore } from "./open-prompt";

/** Key prefix for open prompts; `hitl:open:{requestId}`. */
const OPEN_PROMPT_PREFIX = "hitl:open:";
const promptKey = (requestId: string): string =>
  `${OPEN_PROMPT_PREFIX}${requestId}`;

/**
 * {@link OpenPromptStore} over an agent Durable Object's own storage.
 *
 * Durable for the reason the task store is: a human may answer days later, long
 * after the isolate that asked has been evicted.
 */
export class DurableOpenPrompts implements OpenPromptStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  /**
   * Keep `prompt` until it is answered, and drop prompts older than the HITL TTL
   * while here. A prompt stopped with 🛑 is never answered, so nothing else would
   * ever remove it.
   */
  async put(prompt: OpenPrompt): Promise<void> {
    await this.storage.put<OpenPrompt>(promptKey(prompt.requestId), prompt);
    await this.prune();
  }

  /**
   * Read-and-delete, so an answer counts at most once. The read and the delete
   * are both storage operations with no outgoing I/O between them, so the input
   * gate keeps a second delivery of the same answer from reading in between.
   */
  async take(requestId: string): Promise<OpenPrompt | null> {
    const key = promptKey(requestId);
    const prompt = await this.storage.get<OpenPrompt>(key);
    if (!prompt) return null;
    await this.storage.delete(key);
    return prompt;
  }

  /**
   * One open prompt per paused turn, each gone within the TTL, so the set is small
   * by construction — listing it whole is fine here, unlike the task sweep.
   */
  private async prune(): Promise<void> {
    const cutoff = Date.now() - HITL_REQUEST_TTL_SECONDS * 1000;
    const prompts = await this.storage.list<OpenPrompt>({
      prefix: OPEN_PROMPT_PREFIX
    });
    for (const [key, prompt] of prompts) {
      if (prompt.createdAt < cutoff) await this.storage.delete(key);
    }
  }
}
