import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { getDb } from "@/db/client";
import { registerAgent } from "@/db/models/agents";
import {
  createAgentTask,
  getAgentTaskByToken,
  completeAgentTask,
  updateAgentTaskTaskId,
  deleteAgentTask,
  sweepStaleAgentTasks,
  type CreateAgentTaskInput
} from "@/db/models/agent-tasks";

const db = getDb();

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
});
