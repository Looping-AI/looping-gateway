import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { Message, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import type {
  GenerateTextOnStepFinishCallback,
  StopCondition,
  ToolSet
} from "ai";
import { generateText, stepCountIs } from "ai";
import type { createModelPair } from "@/agents/model";
import { textOf } from "@/a2a/parts";
import type { AgentTurnMetadata } from "@/agents/dispatch";
import type { SessionLike } from "./session";
import {
  assistantSessionMessage,
  toModelMessages,
  userSessionMessage
} from "./messages";

const MAX_STEPS = 8;

const TRANSIENT_REPLY =
  "The AI service is temporarily unavailable. Please try again in a moment.";

/** Recorded in history when a turn is stopped, so it doesn't read as unanswered. */
const CANCELED_NOTE = "(stopped by the user; reply was not delivered)";

export function isTransientAiError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes("3040") ||
    err.message.includes("3046") ||
    err.message.toLowerCase().includes("capacity temporarily exceeded") ||
    err.message.toLowerCase().includes("request timeout")
  );
}

/** What an agent assembles for a single turn (inside the protected body). */
export interface PreparedTurn {
  /** The Durable Object's one Session (history + soul + memory). */
  session: SessionLike;
  /** Per-request system-prompt suffix (caller context). Advisory. */
  systemSuffix: string;
  /** Agent-specific tools merged over the session's own `set_context` tool. */
  tools: ToolSet;
}

export interface AgentTurnConfig {
  models: ReturnType<typeof createModelPair>;
  /**
   * Assemble the session/tools/system for this turn. Runs *inside* the protected
   * body, so throwing here (e.g. missing required metadata) yields the friendly
   * error reply rather than a crash.
   */
  prepare: (
    text: string,
    metadata: Partial<AgentTurnMetadata>
  ) => Promise<PreparedTurn>;
  /** Friendly reply for an unexpected (non-transient) failure. */
  unexpectedReply: string;
  /**
   * Whether a 🛑 has been recorded for this turn, keyed by the dispatch token
   * (the A2A `messageId`). Consulted between tool-calling steps; `true` ends the
   * turn with no reply. Optional so a unit test can drive a turn nothing stops.
   */
  isCanceled?: (token: string) => Promise<boolean>;
}

function agentMessage(
  requestContext: RequestContext,
  messageId: string,
  text: string
): Message {
  return {
    kind: "message",
    messageId,
    role: "agent",
    parts: [{ kind: "text", text }],
    taskId: requestContext.taskId,
    contextId: requestContext.contextId
  };
}

function publishSubmitted(
  eventBus: ExecutionEventBus,
  requestContext: RequestContext
): void {
  eventBus.publish({
    kind: "task",
    id: requestContext.taskId,
    contextId: requestContext.contextId,
    status: { state: "submitted" }
  });
}

function publishStatus(
  eventBus: ExecutionEventBus,
  requestContext: RequestContext,
  text: string,
  messageId: string,
  final: boolean,
  state: "working" | "completed" | "canceled" = final ? "completed" : "working"
): void {
  const update: TaskStatusUpdateEvent = {
    kind: "status-update",
    taskId: requestContext.taskId,
    contextId: requestContext.contextId,
    status: {
      state,
      message: agentMessage(requestContext, messageId, text)
    },
    final
  };
  eventBus.publish(update);
}

/**
 * The generic agent turn shared by every in-repo agent: append the user message,
 * run a Workers-AI `generateText` tool loop over the Session history (primary →
 * fallback model on any error), persist + publish the final reply, and
 * always `finished()`. Agent-specific behavior (which session, which tools, which
 * caller context) is supplied by `cfg.prepare`.
 */
export async function executeAgentTurn(
  requestContext: RequestContext,
  eventBus: ExecutionEventBus,
  cfg: AgentTurnConfig
): Promise<void> {
  const userMessage = requestContext.userMessage;
  const text = textOf(userMessage);
  const metadata = (userMessage.metadata ?? {}) as Partial<AgentTurnMetadata>;
  let modelId = cfg.models.primaryId();
  let completed = false;
  // Set by the stop condition below once a 🛑 is seen for this turn.
  let canceled = false;
  // Tracks the text of the most recent non-terminal step published below, so the
  // terminal reply isn't posted twice when it is that same text.
  let lastStepText = "";

  publishSubmitted(eventBus, requestContext);

  const publishTerminal = (
    reply: string,
    state: "completed" | "canceled" = "completed"
  ): void => {
    if (completed) return;
    completed = true;
    // When generation stops at the step limit on a tool-calling step, that step's
    // text was already streamed as a non-terminal update (`:step:N`) and equals
    // `result.text`. Send an empty terminal so the task still completes and
    // collects the 🛑 without re-posting it (different id ⇒ dedupe would miss it).
    // History still keeps the full reply via `appendMessage`.
    const terminalText = reply && reply === lastStepText ? "" : reply;
    publishStatus(
      eventBus,
      requestContext,
      terminalText,
      `${userMessage.messageId}:final`,
      true,
      state
    );
  };

  try {
    const {
      session,
      systemSuffix,
      tools: extraTools
    } = await cfg.prepare(text, metadata);

    // `text` already carries its `<turn>` provenance wrapper (applied by the
    // Gateway in dispatch); persist it verbatim.
    await session.appendMessage(userSessionMessage(text));
    const history = await session.getHistory();
    const system = (await session.refreshSystemPrompt()) + systemSuffix;
    const tools = { ...(await session.tools()), ...extraTools };

    const onStepFinish: GenerateTextOnStepFinishCallback<ToolSet> = (step) => {
      // Text from a tool-calling step is the agent's only genuine non-terminal
      // content. Tool-only steps stay silent in Slack.
      if (step.toolCalls.length === 0 || !step.text.trim()) return;
      const stepText = step.text.trim();
      lastStepText = stepText;
      publishStatus(
        eventBus,
        requestContext,
        stepText,
        `${userMessage.messageId}:step:${step.stepNumber}`,
        false
      );
    };

    // The gateway's 🛑 workflow runs on its own request and cannot reach into
    // this Durable Object mid-turn, so it records the stop on the task row and
    // the turn reads it back from there.
    const checkCanceled = async (): Promise<boolean> => {
      if (!cfg.isCanceled || canceled) return canceled;
      try {
        canceled = await cfg.isCanceled(userMessage.messageId);
      } catch (err) {
        // A ledger hiccup must not kill a turn that was never asked to stop.
        console.warn("[agent-loop] stop check failed, continuing", {
          contextId: requestContext.contextId,
          err: String(err)
        });
        return false;
      }
      return canceled;
    };

    // Between tool-calling steps — the only place generation can be *interrupted*.
    // A step's tool calls have already run and their results still reach the model.
    const stopIfCanceled: StopCondition<ToolSet> = () => checkCanceled();

    const generateArgs = {
      system,
      messages: toModelMessages(history),
      tools,
      stopWhen: [stepCountIs(MAX_STEPS), stopIfCanceled],
      onStepFinish
    };

    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model: cfg.models.primary(),
        ...generateArgs
      });
    } catch (primaryErr) {
      console.warn(
        "[agent-loop] AI error on primary model, retrying with fallback",
        {
          model: modelId,
          error: String(primaryErr),
          contextId: requestContext.contextId
        }
      );
      modelId = cfg.models.fallbackId();
      result = await generateText({
        model: cfg.models.fallback(),
        ...generateArgs
      });
    }

    // Re-check after generation, not only between steps. A turn the model answers
    // in a single call has no step boundary to be interrupted at, so this is the
    // only chance to notice a 🛑 that landed while it was generating. The work is
    // already spent by then, but the answer must still be withheld: the user was
    // told "🛑 Stopped.", and delivering the reply anyway is the bug this fixes.
    await checkCanceled();

    // Stopped: whatever was produced is abandoned work, not an answer. Publish an
    // empty terminal `canceled` — the gateway posts its own "🛑 Stopped." notice,
    // and any partial output already went out as a step update — and close the
    // turn in history so the next one doesn't reopen it.
    if (canceled) {
      console.info("[agent-loop] turn stopped by the user", {
        contextId: requestContext.contextId,
        model: modelId
      });
      publishTerminal("", "canceled");
      await session.appendMessage(assistantSessionMessage(CANCELED_NOTE));
      return;
    }

    const replyText = result.text.trim();
    const finishReason = result.finishReason;

    if (!replyText || finishReason === "length") {
      if (finishReason === "length") {
        console.warn(
          "[agent-loop] model response truncated (finish_reason=length)",
          {
            model: modelId,
            contextId: requestContext.contextId
          }
        );
      } else {
        console.warn("[agent-loop] empty response from model", {
          model: modelId,
          finishReason,
          contextId: requestContext.contextId
        });
      }
      publishTerminal(TRANSIENT_REPLY);
      return;
    }

    await session.appendMessage(assistantSessionMessage(replyText));
    publishTerminal(replyText);
  } catch (err) {
    console.error("[agent-loop] turn failed", {
      contextId: requestContext.contextId,
      model: modelId,
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    const reply = isTransientAiError(err)
      ? TRANSIENT_REPLY
      : cfg.unexpectedReply;
    publishTerminal(reply);
  } finally {
    eventBus.finished();
  }
}
