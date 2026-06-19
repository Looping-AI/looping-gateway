import { describe, it, expect } from "vitest";
import type { SessionMessage } from "agents/experimental/memory/session";
import { archivingCompaction } from "@/agents/shared/session";

function msg(id: string): SessionMessage {
  return { id, role: "user", parts: [{ type: "text", text: id }] };
}

const history = [msg("a"), msg("b"), msg("c"), msg("d"), msg("e")];

// A base compaction that folds the b..d range into a summary.
const base = (async () => ({
  summary: "sum",
  fromMessageId: "b",
  toMessageId: "d"
})) as unknown as Parameters<typeof archivingCompaction>[0];

describe("archivingCompaction", () => {
  it("hands exactly the displaced range to onArchive and returns the base result", async () => {
    let archived: SessionMessage[] = [];
    const fn = archivingCompaction(base, async (m) => {
      archived = m;
    });
    const result = await fn(history);
    expect(archived.map((m) => m.id)).toEqual(["b", "c", "d"]);
    expect(result).toMatchObject({ fromMessageId: "b", toMessageId: "d" });
  });

  it("returns the base function unchanged when there is no onArchive", () => {
    expect(archivingCompaction(base)).toBe(base);
  });

  it("swallows archive errors so compaction still shortens history", async () => {
    const fn = archivingCompaction(base, async () => {
      throw new Error("vectorize down");
    });
    const result = await fn(history);
    expect(result).toMatchObject({ summary: "sum" });
  });

  it("does not archive when the base compaction returns null", async () => {
    let called = false;
    const nullBase = (async () => null) as unknown as Parameters<
      typeof archivingCompaction
    >[0];
    const fn = archivingCompaction(nullBase, async () => {
      called = true;
    });
    expect(await fn(history)).toBeNull();
    expect(called).toBe(false);
  });
});
