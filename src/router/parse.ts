const AGENT_NAME_CHAR = /[A-Za-z0-9_-]/;

export interface AgentNameMention {
  name: string;
  index: number;
}

function isAgentNameBoundary(text: string, index: number): boolean {
  return (
    index < 0 || index >= text.length || !AGENT_NAME_CHAR.test(text[index])
  );
}

/**
 * Whether an agent-name occurrence is escaped, i.e. the author wrote the name
 * but does not want to wake the agent. Recognised forms:
 *   - backslash prefix:  \Player
 *   - backtick wrap:      `player`
 *   - double-quote wrap:  "player"
 *
 * Only a delimiter sitting directly against the name escapes it, so
 * `the "best player" here` still mentions `player`. Single quotes and smart
 * quotes are intentionally excluded (apostrophe/contraction and mobile-keyboard
 * collisions).
 */
function isEscapedMention(
  text: string,
  start: number,
  length: number
): boolean {
  const before = text[start - 1];
  const after = text[start + length];
  if (before === "\\") return true;
  if (before === '"' && after === '"') return true;
  if (before === "`" && after === "`") return true;
  return false;
}

/**
 * The first whole-token agent name mention in the text, case-insensitive, or
 * null. The returned name keeps the canonical casing from `agentNames`.
 */
export function findAgentNameMention(
  text: string,
  agentNames: readonly string[]
): AgentNameMention | null {
  const lowerText = text.toLowerCase();
  let best: AgentNameMention | null = null;

  for (const name of agentNames) {
    if (!name) continue;
    const lowerName = name.toLowerCase();
    let index = lowerText.indexOf(lowerName);

    while (index !== -1) {
      const before = index - 1;
      const after = index + lowerName.length;
      if (
        isAgentNameBoundary(text, before) &&
        isAgentNameBoundary(text, after) &&
        !isEscapedMention(text, index, lowerName.length) &&
        (!best ||
          index < best.index ||
          (index === best.index && name.length > best.name.length))
      ) {
        best = { name, index };
      }
      index = lowerText.indexOf(lowerName, index + 1);
    }
  }

  return best;
}

/**
 * Every name from `agentNames` that appears as a whole token in the text,
 * case-insensitive. Canonical casing is preserved; each name is returned at
 * most once. Used to fan a message out to all explicitly mentioned agents.
 */
export function findAllAgentNameMentions(
  text: string,
  agentNames: readonly string[]
): string[] {
  const names = agentNames.filter(Boolean);
  if (names.length === 0) return [];

  // Build lowercase→canonical map (first occurrence wins for case duplicates).
  const lowerToCanonical = new Map<string, string>();
  for (const n of names) {
    const lower = n.toLowerCase();
    if (!lowerToCanonical.has(lower)) lowerToCanonical.set(lower, n);
  }

  // Sort longest first so "sales-bot" wins over "sales" in alternation.
  const escaped = [...lowerToCanonical.keys()]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  // Single pass: boundaries mirror isAgentNameBoundary (chars NOT in [A-Za-z0-9_-]).
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_-])(${escaped.join("|")})(?![A-Za-z0-9_-])`,
    "gi"
  );

  const seen = new Set<string>();
  const result: string[] = [];

  for (const match of text.matchAll(pattern)) {
    if (isEscapedMention(text, match.index, match[1].length)) continue;
    const canonical = lowerToCanonical.get(match[1].toLowerCase());
    if (canonical !== undefined && !seen.has(canonical)) {
      seen.add(canonical);
      result.push(canonical);
    }
  }

  return result;
}
