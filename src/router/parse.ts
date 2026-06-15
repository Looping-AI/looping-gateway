// `::name` agent reference: lowercase letters, digits, `_` and `-`.
const AGENT_REF = /::([a-z0-9_-]+)/i;
const AGENT_REF_GLOBAL = /::[a-z0-9_-]+/gi;
// Slack mention token, e.g. `<@U123ABC>` (optionally `<@U123|label>`).
const MENTION_GLOBAL = /<@[A-Z0-9]+(?:\|[^>]+)?>/gi;

/**
 * The first `::name` agent reference in the text, lowercased, or null. This is
 * the explicit routing target ("`::admin reset the registry`").
 */
export function parseAgentRef(text: string): string | null {
  const match = text.match(AGENT_REF);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Strip Slack bot mentions and `::name` references, collapse whitespace — the
 * clean prompt to hand the agent. The chat SDK used to do this; we bypass it now.
 */
export function cleanText(text: string): string {
  return text
    .replace(MENTION_GLOBAL, "")
    .replace(AGENT_REF_GLOBAL, "")
    .replace(/\s+/g, " ")
    .trim();
}
