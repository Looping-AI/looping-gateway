import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { Message, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import type { GenerateTextOnStepFinishCallback, ToolSet } from "ai";
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
  final: boolean
): void {
  const update: TaskStatusUpdateEvent = {
    kind: "status-update",
    taskId: requestContext.taskId,
    contextId: requestContext.contextId,
    status: {
      state: final ? "completed" : "working",
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
  // Tracks the text of the most recent non-terminal step published below, so the
  // terminal reply isn't posted twice when it is that same text.
  let lastStepText = "";

  publishSubmitted(eventBus, requestContext);

  const publishTerminal = (reply: string): void => {
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
      true
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

    const generateArgs = {
      system,
      messages: toModelMessages(history),
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
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
