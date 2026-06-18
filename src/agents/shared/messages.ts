import type { ModelMessage } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";

/**
 * Glue between A2A text and the Agents SDK Sessions store. We persist only the
 * user turn and the assistant's final text — intra-turn tool steps stay inside
 * the single `generateText` call, so history is plain text messages and the
 * conversion to AI-SDK `ModelMessage`s is trivial. Shared by every in-repo agent.
 */

function textPart(text: string): SessionMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }]
  };
}

export function userSessionMessage(text: string): SessionMessage {
  return { ...textPart(text), role: "user" };
}

export function assistantSessionMessage(text: string): SessionMessage {
  return { ...textPart(text), role: "assistant" };
}

/** Concatenate the text parts of a stored session message. */
function sessionText(m: SessionMessage): string {
  return m.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

/** Convert stored history to AI-SDK model messages (user/assistant text only). */
export function toModelMessages(history: SessionMessage[]): ModelMessage[] {
  return history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: sessionText(m)
    }));
}
