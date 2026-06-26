import type { ModelMessage } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";

/**
 * Glue between A2A text and the Agents SDK Sessions store. We persist only the
 * user turn and the assistant's final text — intra-turn tool steps stay inside
 * the single `generateText` call, so history is plain text messages and the
 * conversion to AI-SDK `ModelMessage`s is trivial. Shared by every in-repo agent.
 */

/**
 * Who authored a turn — the WHO the Gateway renders into the `<turn>` wrapper.
 * Used to attribute "who said what" in multi-actor channels (e.g. the admin
 * channel) where a flat `role: "user"` is ambiguous.
 */
export interface TurnAuthor {
  /** Stable actor key — the raw Slack user id (e.g. `U123`). */
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
  /** WHERE — resolved channel name (e.g. `general`), or the channel id as a fallback. Never null. */
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
    id: user.slackUserId,
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

/**
 * Strip any `<turn …>` / `</turn>` lookalikes from user body text so a crafted
 * message cannot inject gateway-authored provenance wrappers into model context.
 */
function sanitizeBody(text: string): string {
  return text.replace(/<\s*\/?\s*turn(\s[^>]*)?\s*>/gi, "");
}

/** Convert a Slack message ts (`"1719331800.123456"`) to an ISO-8601 instant. */
export function slackTsToIso(ts: string): string {
  return new Date(Math.round(parseFloat(ts) * 1000)).toISOString();
}

/**
 * Project a {@link TurnContext} into the authoritative `<turn>` wrapper the
 * Gateway inlines into the outbound message text — the single source of
 * who/where/when read by the model, by remote agents, and (via {@link parseTurn})
 * by the recall archiver. Attributes are escaped with {@link escAttr}; the body
 * is sanitized with {@link sanitizeBody} to strip any `<turn>`/`</turn>` lookalikes
 * that could spoof provenance in the model-visible history.
 */
export function renderTurn(text: string, ctx: TurnContext): string {
  return (
    `<turn from="${escAttr(ctx.author.label)}"` +
    ` id="${escAttr(ctx.author.id)}"` +
    ` channel="${escAttr(ctx.channel)}"` +
    ` at="${escAttr(ctx.at)}">` +
    `${sanitizeBody(text)}</turn>`
  );
}

/** Build the {@link TurnContext} the Gateway wraps each outbound turn with. */
export function turnContextFromPayload(p: {
  user: { slackUserId: string; displayName: string | null };
  channelId: string;
  channelName: string | null;
  messageTs: string;
}): TurnContext {
  return {
    author: authorFromUser(p.user),
    channel: p.channelName ?? p.channelId,
    at: slackTsToIso(p.messageTs)
  };
}

const ATTR_UNESCAPES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"'
};

/** Inverse of {@link escAttr} — single-pass so escaped `&amp;` round-trips. */
function unescAttr(value: string): string {
  return value.replace(/&(amp|lt|gt|quot);/g, (_, e) => ATTR_UNESCAPES[e]);
}

/** The fields recovered from a rendered `<turn>` wrapper. */
export interface ParsedTurn {
  from: string;
  /** Slack user id, as rendered. */
  id: string;
  channel: string;
  at: string;
  /** The raw inner words. */
  body: string;
}

const TURN_TAG_RE = /^<turn\b([^>]*)>([\s\S]*)<\/turn>$/;
const ATTR_RE = /(\w+)="([^"]*)"/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw)) !== null) out[m[1]] = m[2];
  return out;
}

/**
 * Inverse of {@link renderTurn}: recover the structured provenance from a
 * Gateway-authored turn. Returns null for any text that isn't a `<turn>` wrapper
 * (assistant replies, plain text), so callers can treat the fields as optional.
 */
export function parseTurn(text: string): ParsedTurn | null {
  const m = TURN_TAG_RE.exec(text);
  if (!m) return null;
  const attrs = parseAttrs(m[1]);
  if (!attrs.from || !attrs.id || !attrs.channel || !attrs.at) return null;
  return {
    from: unescAttr(attrs.from),
    id: unescAttr(attrs.id),
    channel: unescAttr(attrs.channel),
    at: unescAttr(attrs.at),
    body: m[2]
  };
}

export function userSessionMessage(text: string): SessionMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    createdAt: new Date(),
    parts: [{ type: "text", text }]
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
