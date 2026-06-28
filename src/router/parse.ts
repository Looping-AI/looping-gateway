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
