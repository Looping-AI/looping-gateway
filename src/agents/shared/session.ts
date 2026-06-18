import type { LanguageModel, ToolSet } from "ai";
import { generateText } from "ai";
import { Session } from "agents/experimental/memory/session";
import type { SessionMessage } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";

/**
 * The SQLite-backed host the Sessions API needs — satisfied by the Agents SDK
 * `Agent` (`this.sql`). `env` is passed to executors separately because it's
 * `protected` on `Agent` (only the agent subclass itself can read it).
 */
export interface SessionHost {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

/** The subset of `Session` the agent loop drives — lets tests inject a fake. */
export interface SessionLike {
  appendMessage(
    message: SessionMessage,
    parentId?: string | null
  ): Promise<unknown> | unknown;
  getHistory(): Promise<SessionMessage[]>;
  refreshSystemPrompt(): Promise<string>;
  tools(): Promise<ToolSet>;
}

export interface AgentSessionOptions {
  /** Read-only identity block injected into the system prompt every turn. */
  soul: () => string | Promise<string>;
  /** Description of the writable SQLite `"memory"` scratchpad the model self-edits. */
  memoryDescription: string;
  /** Soft cap (tokens) for the `"memory"` block. */
  memoryMaxTokens: number;
  /** History token threshold that triggers compaction. */
  compactAfterTokens: number;
}

/**
 * Build the one `Session` an agent Durable Object owns: a read-only `"soul"`
 * identity block + a writable `"memory"` scratchpad, with history compaction
 * summarized by the same model. Shared by the admin and onboarding agents — only
 * the soul/memory text differ.
 */
export function buildAgentSession(
  agent: SessionHost,
  model: LanguageModel,
  opts: AgentSessionOptions
): Session {
  return Session.create(agent)
    .withContext("soul", { provider: { get: async () => opts.soul() } })
    .withContext("memory", {
      description: opts.memoryDescription,
      maxTokens: opts.memoryMaxTokens
    })
    .onCompaction(
      createCompactFunction({
        summarize: (prompt) =>
          generateText({ model, prompt }).then((r) => r.text)
      })
    )
    .compactAfter(opts.compactAfterTokens);
}
