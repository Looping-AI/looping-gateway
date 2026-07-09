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

/** Pending (not-yet-completed) tasks for a Slack trigger event — the reaction backstop reads these. */
export async function getPendingAgentTasksByEventId(
  eventId: string
): Promise<AgentTaskRow[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.agentTasks)
    .where(
      and(
        eq(schema.agentTasks.eventId, eventId),
        eq(schema.agentTasks.status, "pending")
      )
    );
}

/**
 * Fill in the remote-assigned A2A Task id once the accept response is known.
 * The row is written before dispatch (with `taskId` null) to close the
 * accept→record race, so this best-effort update backfills the id afterwards.
 * Conditional on `pending` so a task the callback already completed is untouched.
 */
export async function updateAgentTaskTaskId(
  token: string,
  taskId: string
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.agentTasks)
    .set({ taskId })
    .where(
      and(
        eq(schema.agentTasks.token, token),
        eq(schema.agentTasks.status, "pending")
      )
    );
}

/**
 * Record why a callback was rejected, so the reaction backstop can surface the
 * reason instead of silence. Conditional on `pending` so a completed task is
 * never reopened. `message` must be a gateway-controlled string — never remote
 * payload — since it can be posted to Slack verbatim.
 */
export async function recordAgentTaskError(
  token: string,
  message: string
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.agentTasks)
    .set({ lastError: message })
    .where(
      and(
        eq(schema.agentTasks.token, token),
        eq(schema.agentTasks.status, "pending")
      )
    );
}

/**
 * Record that an intermediate update's `messageId` has been received (and its
 * text posted to Slack) for a task, so an at-least-once push retry does not
 * double-post the same progress message. The append-if-absent is a single
 * atomic UPDATE (no app-side read-modify-write, so concurrent callbacks can't
 * race): it only appends when the id is not already present in the
 * comma-delimited `received_message_ids` set. Returns `true` when a row was
 * updated (this update was new → the caller should post it); `false` when the
 * id was already recorded or the task is no longer `pending`. The surrounding
 * commas in the `LIKE` guard make the membership test exact.
 */
export async function recordReceivedMessageId(
  token: string,
  messageId: string
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .update(schema.agentTasks)
    .set({
      receivedMessageIds: sql`coalesce(${schema.agentTasks.receivedMessageIds} || ',', '') || ${messageId}`
    })
    .where(
      and(
        eq(schema.agentTasks.token, token),
        eq(schema.agentTasks.status, "pending"),
        sql`(',' || coalesce(${schema.agentTasks.receivedMessageIds}, '') || ',') NOT LIKE ${"%," + messageId + ",%"}`
      )
    )
    .returning({ token: schema.agentTasks.token });
  return rows.length > 0;
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
 * Delete a task row by its token PK. Used to clean up a row written *before*
 * dispatch when the dispatch does not end in `accepted` (policy rejection or
 * exhausted retries) — no remote callback will ever arrive for it, so it must
 * not linger as a stale `pending` row for the reaction backstop to scan.
 */
export async function deleteAgentTask(token: string): Promise<void> {
  const db = getDb();
  await db.delete(schema.agentTasks).where(eq(schema.agentTasks.token, token));
}

/**
 * Delete rows older than `olderThanSeconds` (default 30 days). Called by the
 * nightly maintenance workflow to keep the table from growing unbounded.
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
