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

/**
 * Structured, extensible source-of-truth for a user turn's provenance —
 * who / where / when. {@link renderTurn} projects it into the persisted text;
 * adding a future field means adding an attribute, not changing the format.
 */
export interface TurnContext {
  /** WHO authored the turn. */
  author: TurnAuthor;
  /** WHERE — resolved channel name (`#general`), or the channel id as a fallback. Never null. */
  channel: string;
  /** WHEN — the turn instant as ISO-8601 (see {@link slackTsToIso}). */
  at: string;
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

const ATTR_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
};

/** Escape a value for safe use inside a double-quoted XML attribute. */
function escAttr(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ATTR_ESCAPES[c]);
}

/** Convert a Slack message ts (`"1719331800.123456"`) to an ISO-8601 instant. */
export function slackTsToIso(ts: string): string {
  return new Date(Math.round(parseFloat(ts) * 1000)).toISOString();
}

/**
 * Project a {@link TurnContext} into the authoritative `<turn>` wrapper persisted
 * as the user turn's text, so who/where/when survive in history (and recall
 * embeddings) for multi-actor channels. The element and its attributes are
 * gateway-applied and authoritative; the body is the user's raw words, kept
 * unescaped so code/markdown read naturally for the model. Attribution is
 * advisory — the real authorization boundary lives in each tool, not the prompt —
 * so a body containing a lookalike `</turn>` is cosmetic, not a spoof. The `slack:`
 * source prefix is dropped from the `id` attribute since every turn is from Slack.
 */
export function renderTurn(text: string, ctx: TurnContext): string {
  const id = ctx.author.id.replace(/^slack:/, "");
  return (
    `<turn from="${escAttr(ctx.author.label)}"` +
    ` id="${escAttr(id)}"` +
    ` channel="${escAttr(ctx.channel)}"` +
    ` at="${escAttr(ctx.at)}">` +
    `${text}</turn>`
  );
}

export function userSessionMessage(
  text: string,
  ctx?: TurnContext
): SessionMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    createdAt: new Date(),
    parts: [{ type: "text", text: ctx ? renderTurn(text, ctx) : text }]
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
