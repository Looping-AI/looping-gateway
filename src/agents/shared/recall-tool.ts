import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { recall } from "@/agents/shared/recall";

/**
 * The single `recall` tool — semantic search over the agent's own archived
 * (compacted-away) history. No tool proliferation: one tool, shared by every
 * in-repo agent.
 *
 * Gated on `hasArchive` (= the instance has compacted at least once): before the
 * first compaction everything is still in live context, so the tool would only
 * return things the model already has. The `namespace` is bound by the caller
 * from the instance's own key — never from model input — so the model cannot
 * reach another instance's history.
 */
export function recallTools(namespace: string, hasArchive: boolean): ToolSet {
  if (!hasArchive) return {};
  return {
    recall: tool({
      description:
        "Search your archived earlier conversations (older history that has " +
        "scrolled out of the current context) for relevant past quotes. Use " +
        "when the user refers to something from a while ago that you don't see " +
        "in the messages above.",
      inputSchema: z.object({
        query: z.string().describe("What to look for in past conversations"),
        topK: z.coerce
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("How many past snippets to return (default 5)")
      }),
      execute: async ({ query, topK }) => {
        const hits = await recall(namespace, query, topK ?? 5);
        return hits.length > 0
          ? { hits }
          : { hits: [], note: "No relevant earlier messages found." };
      }
    })
  };
}
