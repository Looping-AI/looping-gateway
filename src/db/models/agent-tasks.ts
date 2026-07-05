import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "../client";
import * as schema from "../schema";

const ONE_MONTH_SECONDS = 30 * 24 * 60 * 60;

export type AgentTaskRow = typeof schema.agentTasks.$inferSelect;

/** Everything captured at dispatch so the async callback can correlate, route, and collect. */
export interface CreateAgentTaskInput {
  /** Gateway-generated push-notification validation token (PK, echoed by the remote). */
  token: string;
  /** Remote-assigned A2A Task id from the accept response (null if the accept omitted it). */
  taskId: string | null;
  agentName: string;
  channelId: string;
  /** Thread to reply into; null = post at channel top-level. */
  replyThreadTs: string | null;
  eventId: string;
}

/**
 * Record a pending remote task at dispatch time. Idempotent on the `token` PK so
 * the workflow's `record-task` step can retry (or a duplicate dispatch land)
 * without erroring or clobbering an already-recorded row.
 */
export async function createAgentTask(
  input: CreateAgentTaskInput
): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.agentTasks)
    .values({
      token: input.token,
      taskId: input.taskId,
      agentName: input.agentName,
      channelId: input.channelId,
      replyThreadTs: input.replyThreadTs,
      eventId: input.eventId
    })
    .onConflictDoNothing();
}

/** Look up a pending/known task by its validation token (the callback's correlation key). */
export async function getAgentTaskByToken(
  token: string
): Promise<AgentTaskRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.agentTasks)
    .where(eq(schema.agentTasks.token, token))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Mark a task completed. Conditional on it still being `pending` so a duplicate
 * or replayed callback flips exactly one row — the returned count is the caller's
 * idempotency signal (1 = we own this callback; 0 = already handled).
 */
export async function completeAgentTask(token: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .update(schema.agentTasks)
    .set({ status: "completed", completedAt: sql`(unixepoch())` })
    .where(
      and(
        eq(schema.agentTasks.token, token),
        eq(schema.agentTasks.status, "pending")
      )
    )
    .returning({ token: schema.agentTasks.token });
  return rows.length > 0;
}

/**
 * Delete rows older than `olderThanSeconds` (default 24h). The reaction backstop
 * already clears the ⏳ for tasks that never call back, so these rows are pure
 * bookkeeping — sweeping them keeps the table from growing unbounded.
 */
export async function sweepStaleAgentTasks(
  olderThanSeconds = ONE_MONTH_SECONDS
): Promise<number> {
  const db = getDb();
  const cutoff = sql`(unixepoch() - ${olderThanSeconds})`;
  const rows = await db
    .delete(schema.agentTasks)
    .where(lt(schema.agentTasks.createdAt, cutoff))
    .returning({ token: schema.agentTasks.token });
  return rows.length;
}
