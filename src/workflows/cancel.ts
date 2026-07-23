import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { CancelWorkflowParams } from "@/slack/types";
import { getAgent } from "@/db/models/agents";
import {
  getPendingAgentTasksByChannelAndTs,
  markCancelRequested,
  completeAgentTask,
  type AgentTaskRow
} from "@/db/models/agent-tasks";
import { type DispatchAgentRef } from "@/agents/dispatch";
import { cancelHitlRequestsByToken } from "@/db/models/hitl-requests";
import { markHitlPromptResolved } from "@/a2a/notifications/hitl";
import { postReply } from "@/wrappers/slack";
import {
  cancelAndReconcile,
  cancelNotHonoredText,
  collectIfEventDrained,
  type CancelRowKind
} from "@/workflows/message-helpers";

interface CancelRowResult {
  agentName: string;
  kind: CancelRowKind;
}

/**
 * Stop one pending task via the standard A2A `tasks/cancel`, reconciling the
 * gateway ledger from the (synchronous) response — a conformant agent sends no
 * push callback after cancellation, so the gateway is the source of truth here.
 *
 * Handles the taskId race: if the accept hasn't returned a taskId yet, record a
 * `cancelRequested` intent instead. If that atomic mark reveals the accept just
 * committed (taskId now present), cancel directly; otherwise the dispatch's
 * accept path honors the intent. Exactly one cancel fires either way.
 *
 * Exported for unit testing.
 */
export async function cancelTaskRow(
  row: AgentTaskRow
): Promise<CancelRowResult> {
  const agent = await getAgent(row.agentName);
  if (!agent) {
    // Agent deregistered mid-flight — nothing to cancel; reconcile the row.
    await completeAgentTask(row.token);
    return { agentName: row.agentName, kind: "stopped" };
  }
  const ref: DispatchAgentRef = {
    name: agent.name,
    kind: agent.kind,
    a2aEndpoint: agent.a2aEndpoint,
    workspaceId: agent.workspaceId
  };

  let taskId = row.taskId;
  if (!taskId) {
    const mark = await markCancelRequested(row.token);
    // Row completed/purged between resolve and now, or intent recorded for a
    // task whose taskId is still unknown → the accept path (dispatch) honors it.
    if (!mark.matched || !mark.taskId) {
      return { agentName: row.agentName, kind: "stopped" };
    }
    taskId = mark.taskId; // accept raced in — cancel directly now
  }

  // Completes the row only for terminal outcomes; a task that can't be canceled
  // keeps its row pending so the reply it still produces reaches Slack.
  const kind = await cancelAndReconcile(ref, taskId, row.token);

  // Close any human-in-the-loop prompt the task had open (the 🛑 supersedes it),
  // and strip its now-dead buttons in Slack. Independent of the cancel outcome:
  // the user chose to stop, so the pending question no longer stands.
  const canceledPrompts = await cancelHitlRequestsByToken(row.token);
  for (const prompt of canceledPrompts) {
    await markHitlPromptResolved(prompt, "🛑 Canceled.");
  }

  return { agentName: row.agentName, kind };
}

/**
 * Durable workflow for a 🛑 stop reaction. One instance per reaction `event_id`.
 * Looks up every pending task the reacted trigger message woke (the fan-out) and
 * cancels them all via A2A `tasks/cancel`, then drains the 🛑 reaction and posts a
 * short confirmation. Idempotent: `completeAgentTask` and the reaction collect are
 * both no-ops on replay.
 */
export class CancelWorkflow extends WorkflowEntrypoint<
  Env,
  CancelWorkflowParams
> {
  async run(event: WorkflowEvent<CancelWorkflowParams>, step: WorkflowStep) {
    const p = event.payload;
    try {
      const rows = await step.do("resolve-tasks", () =>
        getPendingAgentTasksByChannelAndTs(p.channelId, p.ts)
      );
      if (rows.length === 0) return; // nothing in flight for this message

      const results: CancelRowResult[] = [];
      for (const row of rows) {
        results.push(
          await step.do(`cancel:${row.token}`, () => cancelTaskRow(row))
        );
      }

      await step.do("finalize", async () => {
        const threadTs = rows[0].replyThreadTs;
        const stopped = results.filter((r) => r.kind === "stopped");
        // `unsupported` and `error` both leave the agent running to completion,
        // so the user hears the same thing for either.
        const stillRunning = results.filter((r) => r.kind !== "stopped");

        // App-branded gateway notices (null username), never an agent reply.
        if (stopped.length > 0) {
          await postReply(p.channelId, threadTs, "🛑 Stopped.", null, null);
        }
        for (const r of stillRunning) {
          await postReply(
            p.channelId,
            threadTs,
            cancelNotHonoredText(r.agentName),
            null,
            null
          );
        }

        // Clear the 🛑 for each affected trigger event once its fan-out drained.
        // (Rows share the trigger event_id; dedupe defensively.)
        for (const eid of [...new Set(rows.map((r) => r.eventId))]) {
          await collectIfEventDrained(eid);
        }
      });
    } catch (err) {
      console.error("[cancel] workflow run failed", {
        instanceId: event.instanceId,
        eventId: p.eventId,
        channelId: p.channelId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      });
      throw err;
    }
  }
}
