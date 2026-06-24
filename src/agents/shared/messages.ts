import type { ModelMessage } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";

/**
 * Glue between A2A text and the Agents SDK Sessions store. We persist only the
 * user turn and the assistant's final text — intra-turn tool steps stay inside
 * the single `generateText` call, so history is plain text messages and the
 * conversion to AI-SDK `ModelMessage`s is trivial. Shared by every in-repo agent.
 */

/**
 * Who authored a stored user turn. Mirrors the wire-level
 * `RemoteProvenance.author` so local session history and remote dispatch share
 * one notion of an actor. Used to attribute "who said what" in multi-actor
 * channels (e.g. the admin channel) where a flat `role: "user"` is ambiguous.
 */
export interface TurnAuthor {
  /** Stable, source-qualified actor key (e.g. `slack:U123`). */
  id: string;
  /** Human-readable name, falling back to the raw user id. */
  label: string;
}

/** Derive a {@link TurnAuthor} from a Slack-resolved caller. */
export function authorFromUser(user: {
  slackUserId: string;
  displayName: string | null;
}): TurnAuthor {
  return {
    id: `slack:${user.slackUserId}`,
    label: user.displayName ?? user.slackUserId
  };
}

/**
 * Prefix a user turn with its author so the speaker is preserved in persisted
 * history (and recall embeddings) for multi-actor channels. The leading
 * `Label (id):` is gateway-applied and authoritative; any lookalike text the
 * user typed is just inner content. Attribution is advisory — the real
 * authorization boundary lives in each tool, not the prompt.
 */
export function attributeTurnText(text: string, author: TurnAuthor): string {
  return `${author.label} (${author.id}): ${text}`;
}

export function userSessionMessage(
  text: string,
  author?: TurnAuthor
): SessionMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    createdAt: new Date(),
    parts: [
      { type: "text", text: author ? attributeTurnText(text, author) : text }
    ]
  };
}

export function assistantSessionMessage(text: string): SessionMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    createdAt: new Date(),
    parts: [{ type: "text", text }]
  };
}

/** Concatenate the text parts of a stored session message. */
export function sessionText(m: SessionMessage): string {
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
