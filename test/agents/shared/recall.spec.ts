import { describe, it, expect, vi } from "vitest";
import type { SessionMessage } from "agents/experimental/memory/session";
import { archiveMessages, recall } from "@/agents/shared/recall";
import { recallTools } from "@/agents/shared/recall-tool";

function msg(
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt: Date | string | undefined = new Date("2025-01-15T10:00:00.000Z")
): SessionMessage {
  return {
    id,
    role,
    createdAt: createdAt as Date,
    parts: [{ type: "text", text }]
  };
}

/** A message with no text part (e.g. a tool step) — should be skipped. */
const toolOnly = {
  id: "tool1",
  role: "assistant",
  parts: [{ type: "tool-call", toolCallId: "x", toolName: "y", input: {} }]
} as unknown as SessionMessage;

function fakeEnv() {
  const upsert = vi.fn(async (vectors: unknown[]) => ({
    mutationId: "m",
    count: vectors.length
  }));
  const query = vi.fn(async (vector: number[], options: unknown) => ({
    count: 1,
    matches: [
      {
        id: "a",
        score: 0.91,
        metadata: {
          role: "user",
          text: "deploy plan",
          createdAt: "2025-01-15T10:00:00.000Z"
        }
      }
    ]
  }));
  // One vector per input text; value encodes batch position so order is checkable.
  const run = vi.fn(async (model: string, input: { text: string[] }) => ({
    data: input.text.map((_, i) => [i, i + 1, i + 2])
  }));
  const env = { AI: { run }, VECTORIZE: { upsert, query } } as unknown as Env;
  return { env, upsert, query, run };
}

describe("archiveMessages", () => {
  it("upserts one vector per non-empty message, keyed by message id, scoped to namespace", async () => {
    const { env, upsert, run } = fakeEnv();
    await archiveMessages(env, "admin:7", [
      msg("a", "user", "hello"),
      msg("b", "assistant", "  "), // whitespace → skipped
      toolOnly, // no text → skipped
      msg("c", "user", "world")
    ]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    const vectors = upsert.mock.calls[0][0] as Array<{
      id: string;
      values: number[];
      namespace: string;
      metadata: { role: string; text: string; createdAt: string };
    }>;
    expect(vectors.map((v) => v.id)).toEqual(["a", "c"]);
    expect(vectors.every((v) => v.namespace === "admin:7")).toBe(true);
    expect(vectors[0].metadata).toEqual({
      role: "user",
      text: "hello",
      createdAt: "2025-01-15T10:00:00.000Z"
    });
    expect(vectors[1].metadata.text).toBe("world");
    expect(vectors[0].values.length).toBeGreaterThan(0);
  });

  it("no-ops on an empty / all-skipped batch (no AI or Vectorize calls)", async () => {
    const { env, upsert, run } = fakeEnv();
    await archiveMessages(env, "admin:0", [toolOnly, msg("x", "user", "   ")]);
    expect(run).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("preserves a string createdAt after JSON round-trip", async () => {
    const { env, upsert } = fakeEnv();
    // After getHistory() round-trip, createdAt is a string, not a Date.
    await archiveMessages(env, "admin:0", [
      msg("r", "user", "round-trip", "2024-11-01T09:00:00.000Z")
    ]);
    const vectors = upsert.mock.calls[0][0] as Array<{
      metadata: { createdAt: string };
    }>;
    expect(vectors[0].metadata.createdAt).toBe("2024-11-01T09:00:00.000Z");
  });

  it("skips messages that have no createdAt (no upsert)", async () => {
    const { env, upsert, run } = fakeEnv();
    // Build directly — the msg() helper always sets a default createdAt.
    const noTs = {
      id: "x",
      role: "user",
      parts: [{ type: "text", text: "has text" }]
    } as unknown as SessionMessage;
    await archiveMessages(env, "admin:0", [noTs]);
    expect(run).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("batches embeddings under the per-call cap but upserts once", async () => {
    const { env, upsert, run } = fakeEnv();
    const many = Array.from({ length: 150 }, (_, i) =>
      msg(`m${i}`, "user", `t${i}`)
    );
    await archiveMessages(env, "admin:0", many);
    expect(run).toHaveBeenCalledTimes(2); // 100 + 50
    expect(upsert).toHaveBeenCalledTimes(1);
    expect((upsert.mock.calls[0][0] as unknown[]).length).toBe(150);
  });
});

describe("recall", () => {
  it("queries within the namespace and maps matches to hits", async () => {
    const { env, query } = fakeEnv();
    const hits = await recall(env, "admin:7", "how did we deploy?", 3);
    expect(query).toHaveBeenCalledTimes(1);
    const opts = query.mock.calls[0][1] as {
      namespace: string;
      topK: number;
      returnMetadata: string;
    };
    expect(opts.namespace).toBe("admin:7");
    expect(opts.topK).toBe(3);
    expect(opts.returnMetadata).toBe("all");
    expect(hits).toEqual([
      {
        role: "user",
        text: "deploy plan",
        score: 0.91,
        createdAt: "2025-01-15T10:00:00.000Z"
      }
    ]);
  });

  it("short-circuits an empty query without touching AI or Vectorize", async () => {
    const { env, query, run } = fakeEnv();
    expect(await recall(env, "admin:0", "   ")).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});

describe("recallTools (gating)", () => {
  it("omits the recall tool before the first compaction", () => {
    const { env } = fakeEnv();
    expect(Object.keys(recallTools(env, "admin:0", false))).toEqual([]);
  });

  it("exposes a single recall tool once an archive exists", async () => {
    const { env } = fakeEnv();
    const tools = recallTools(env, "admin:7", true);
    expect(Object.keys(tools)).toEqual(["recall"]);

    const execute = tools.recall.execute as (
      args: { query: string; topK?: number },
      opts?: unknown
    ) => Promise<{ hits: unknown[]; note?: string }>;
    const out = await execute({ query: "deploy" }, {});
    expect(out.hits).toHaveLength(1);
  });

  it("returns a note when the archive has no matching results", async () => {
    const emptyQuery = vi.fn(async (vector: number[], options: unknown) => ({
      count: 0,
      matches: []
    }));
    const { run } = fakeEnv();
    const emptyEnv = {
      AI: { run },
      VECTORIZE: { query: emptyQuery }
    } as unknown as Env;
    const tools = recallTools(emptyEnv, "admin:0", true);
    const execute = tools.recall.execute as (
      args: { query: string },
      opts?: unknown
    ) => Promise<{ hits: unknown[]; note?: string }>;

    const out = await execute({ query: "something obscure" }, {});
    expect(out.hits).toHaveLength(0);
    expect(out.note).toMatch(/no relevant/i);
  });
});
