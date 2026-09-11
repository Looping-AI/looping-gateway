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
   * Hand the prompt `requestId` answers to `record`, and forget it only once
   * `record` has finished.
   *
   * The order is the point. Deleting first opens a window in which a reset of this
   * object loses an answer the gatekeeper has already marked as given and will not
   * send again. Recording first means the worst a reset can leave behind is a prompt
   * that was already answered, which the TTL prune removes. A `record` that throws
   * leaves the prompt where it was.
   */
  async settle(
    requestId: string,
    record: (prompt: OpenPrompt) => Promise<void>
  ): Promise<OpenPrompt | null> {
    const key = promptKey(requestId);
    const prompt = await this.storage.get<OpenPrompt>(key);
    if (!prompt) return null;
    await record(prompt);
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
