import type { Task } from "@a2a-js/sdk";
import { agentRenderIdentity, type AgentRow } from "@/db/models/agents";
import {
  completeAgentTask,
  recordReceivedMessageId,
  type AgentTaskRow
} from "@/db/models/agent-tasks";
import { extractText, isTerminalTaskState } from "@/a2a/parts";
import { sanitizeAgentReply } from "@/a2a/client";
import { postReply } from "@/wrappers/slack";
import { collectIfEventDrained } from "@/workflows/message-helpers";

/** A malformed Task snapshot that is safe to report to a task's owner. */
export class TaskDeliveryValidationError extends Error {}

/**
 * Gateway-controlled notice posted when an agent ends a turn in a failure state
 * without text of its own. It contains no agent-controlled content.
 */
function terminalFailureNotice(agentName: string, state: string): string {
  return `*Agent ${agentName}* ended without a reply (state: ${state}). If you were expecting an answer, please contact the agent developer.`;
}

/**
 * Deliver one trusted Task snapshot through the durable task ledger. Each
 * notification boundary authenticates and validates its caller before invoking
 * this function; the agent's text is sanitized here regardless of boundary,
 * since even a built-in agent relays untrusted model output.
 */
export async function deliverTaskToSlack(
  token: string,
  row: AgentTaskRow,
  agent: AgentRow,
  task: Task
): Promise<void> {
  const state = task.status.state;
  const text = sanitizeAgentReply(extractText(task));
  // Resolved per delivery rather than carried from dispatch, so a rename or a
  // regenerated avatar mid-turn takes effect on the reply it produced. Deferred
  // until we know we are posting: most status updates are deduplicated or empty,
  // and for the admin agent this resolution costs extra config reads.
  const renderIdentity = () => agentRenderIdentity(agent, row.channelId);

  if (!isTerminalTaskState(state)) {
    const updateId = task.status.message?.messageId;
    if (!updateId) {
      throw new TaskDeliveryValidationError(
        "non-terminal task updates must include a status.message.messageId; the gateway uses this to deduplicate at-least-once delivery"
      );
    }

    const isNew = await recordReceivedMessageId(token, updateId);
    if (isNew && text) {
      const { displayName, iconUrl } = await renderIdentity();
      await postReply(
        row.channelId,
        row.replyThreadTs,
        text,
        displayName,
        iconUrl
      );
    }
    return;
  }

  // A stop is an outcome the user chose, not a failure to explain — and the
  // cancel workflow already posted "🛑 Stopped." Treat `canceled` like
  // `completed` and stay silent; only real failures get the notice.
  const isChosenOutcome = state === "completed" || state === "canceled";

  // Post before completion so a delivery failure leaves the row pending for a
  // retry. A replay after completion becomes a no-op at the boundary.
  if (text || !isChosenOutcome) {
    const { displayName, iconUrl } = await renderIdentity();
    await postReply(
      row.channelId,
      row.replyThreadTs,
      text || terminalFailureNotice(displayName, state),
      displayName,
      iconUrl
    );
  }

  // Clear the 🛑 only when this was the last pending task of the fan-out; other
  // agents woken by the same trigger message may still be working.
  if (await completeAgentTask(token)) {
    await collectIfEventDrained(row.eventId);
  }
}
