import { describe, it, expect, beforeEach } from "vitest";
import { registerAgent } from "@/db/models/agents";
import {
  createAgentTask,
  getAgentTaskByToken,
  completeAgentTask,
  recordReceivedMessageId,
  updateAgentTaskTaskId,
  deleteAgentTask,
  sweepStaleAgentTasks,
  type CreateAgentTaskInput
} from "@/db/models/agent-tasks";

// agent_tasks.agent_name is an FK; seed a real agent so inserts satisfy it.
beforeEach(async () => {
  await registerAgent({
    name: "remoteagent",
    kind: "custom",
    a2aEndpoint: "https://agent.example.com/a2a",
    notifyOn: "mention",
    workspaceId: 0
  });
});

function input(token: string, over: Partial<CreateAgentTaskInput> = {}) {
  return {
    token,
    taskId: "task-1",
    agentName: "remoteagent",
    channelId: "C1",
    replyThreadTs: null,
    eventId: "Ev1",
    ...over
  } satisfies CreateAgentTaskInput;
}

describe("agent-tasks model", () => {
  it("creates and reads a pending task", async () => {
    await createAgentTask(input("tok-a"));
    const row = await getAgentTaskByToken("tok-a");
    expect(row).not.toBeNull();
    expect(row?.status).toBe("pending");
    expect(row?.channelId).toBe("C1");
    expect(row?.replyThreadTs).toBeNull();
  });

  it("is idempotent on the token PK (no throw, no clobber)", async () => {
    await createAgentTask(input("tok-b", { channelId: "C1" }));
    // A retry with a different payload must not overwrite the original row.
    await createAgentTask(input("tok-b", { channelId: "C_OTHER" }));
    const row = await getAgentTaskByToken("tok-b");
    expect(row?.channelId).toBe("C1");
  });

  it("completes exactly once (idempotency signal)", async () => {
    await createAgentTask(input("tok-c"));
    expect(await completeAgentTask("tok-c")).toBe(true);
    // Second flip is a no-op — the row is already completed.
    expect(await completeAgentTask("tok-c")).toBe(false);
    const row = await getAgentTaskByToken("tok-c");
    expect(row?.status).toBe("completed");
    expect(row?.completedAt).not.toBeNull();
  });

  it("backfills the remote task id on a pending row, not a completed one", async () => {
    await createAgentTask(input("tok-upd", { taskId: null }));
    await updateAgentTaskTaskId("tok-upd", "task-remote-9");
    expect((await getAgentTaskByToken("tok-upd"))?.taskId).toBe(
      "task-remote-9"
    );

    // Once completed, the callback owns the row — a late backfill must not touch it.
    expect(await completeAgentTask("tok-upd")).toBe(true);
    await updateAgentTaskTaskId("tok-upd", "task-remote-late");
    expect((await getAgentTaskByToken("tok-upd"))?.taskId).toBe(
      "task-remote-9"
    );
  });

  it("deletes a row by token, and is a no-op on an unknown token", async () => {
    await createAgentTask(input("tok-del"));
    expect(await getAgentTaskByToken("tok-del")).not.toBeNull();
    await deleteAgentTask("tok-del");
    expect(await getAgentTaskByToken("tok-del")).toBeNull();
    // Deleting a token that was never written (or already gone) must not throw.
    await expect(deleteAgentTask("tok-nope")).resolves.toBeUndefined();
  });

  it("sweeps only rows older than the cutoff", async () => {
    await createAgentTask(input("tok-d"));
    // Fresh rows survive a 24h sweep...
    expect(await sweepStaleAgentTasks(24 * 60 * 60)).toBe(0);
    expect(await getAgentTaskByToken("tok-d")).not.toBeNull();
    // ...but a negative window (cutoff in the future) collects everything.
    expect(await sweepStaleAgentTasks(-10)).toBeGreaterThanOrEqual(1);
    expect(await getAgentTaskByToken("tok-d")).toBeNull();
  });

  describe("recordReceivedMessageId", () => {
    it("returns true and records the id on first call", async () => {
      await createAgentTask(input("tok-rid-a"));
      expect(await recordReceivedMessageId("tok-rid-a", "msg-1")).toBe(true);
      const row = await getAgentTaskByToken("tok-rid-a");
      expect(row?.receivedMessageIds).toContain("msg-1");
    });

    it("returns false and does not duplicate on a repeated id (idempotent)", async () => {
      await createAgentTask(input("tok-rid-b"));
      expect(await recordReceivedMessageId("tok-rid-b", "msg-1")).toBe(true);
      expect(await recordReceivedMessageId("tok-rid-b", "msg-1")).toBe(false);
      const row = await getAgentTaskByToken("tok-rid-b");
      // Exactly one occurrence in the stored string.
      expect(row?.receivedMessageIds?.split("msg-1").length).toBe(2);
    });

    it("accumulates multiple distinct ids", async () => {
      await createAgentTask(input("tok-rid-c"));
      expect(await recordReceivedMessageId("tok-rid-c", "msg-1")).toBe(true);
      expect(await recordReceivedMessageId("tok-rid-c", "msg-2")).toBe(true);
      expect(await recordReceivedMessageId("tok-rid-c", "msg-3")).toBe(true);
      const row = await getAgentTaskByToken("tok-rid-c");
      expect(row?.receivedMessageIds).toContain("msg-1");
      expect(row?.receivedMessageIds).toContain("msg-2");
      expect(row?.receivedMessageIds).toContain("msg-3");
    });

    it("does not match a substring as a duplicate (msg-1 vs msg-10)", async () => {
      await createAgentTask(input("tok-rid-d"));
      expect(await recordReceivedMessageId("tok-rid-d", "msg-1")).toBe(true);
      // msg-10 must be treated as a new id, not a duplicate of msg-1.
      expect(await recordReceivedMessageId("tok-rid-d", "msg-10")).toBe(true);
    });

    it("treats LIKE metacharacters in the id literally, not as wildcards", async () => {
      await createAgentTask(input("tok-rid-wild"));
      // Store a concrete id, then push a distinct id whose `_`/`%` would be
      // wildcards under a LIKE membership test and falsely match it — dropping
      // a genuine update. With an exact (instr) check both must be recorded.
      expect(await recordReceivedMessageId("tok-rid-wild", "msg-1")).toBe(true);
      expect(await recordReceivedMessageId("tok-rid-wild", "msg-_")).toBe(true);
      expect(await recordReceivedMessageId("tok-rid-wild", "%")).toBe(true);
      // And each remains idempotent on its own literal value.
      expect(await recordReceivedMessageId("tok-rid-wild", "msg-_")).toBe(
        false
      );
      expect(await recordReceivedMessageId("tok-rid-wild", "%")).toBe(false);
    });

    it("strips commas and whitespace from the id before storing/matching", async () => {
      await createAgentTask(input("tok-rid-comma"));
      // The comma is the set delimiter (a raw one would corrupt membership) and
      // whitespace is meaningless in an opaque id, so both are removed: `a, b`
      // is recorded as `ab` and a later `ab` is deduped against it.
      expect(await recordReceivedMessageId("tok-rid-comma", "a, b")).toBe(true);
      const row = await getAgentTaskByToken("tok-rid-comma");
      expect(row?.receivedMessageIds).toBe("ab");
      expect(await recordReceivedMessageId("tok-rid-comma", "ab")).toBe(false);
    });

    it("returns false for a completed task", async () => {
      await createAgentTask(input("tok-rid-e"));
      await completeAgentTask("tok-rid-e");
      expect(await recordReceivedMessageId("tok-rid-e", "msg-1")).toBe(false);
    });

    it("returns false for an unknown token", async () => {
      expect(await recordReceivedMessageId("tok-nope", "msg-1")).toBe(false);
    });
  });
});
