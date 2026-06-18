import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { Message } from "@a2a-js/sdk";
import type { LanguageModel, ToolSet } from "ai";
import { generateText, stepCountIs } from "ai";
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
  model: LanguageModel;
  /** Tried when the primary model throws (e.g. capacity). */
  fallbackModel: LanguageModel;
  primaryModelId: string;
  fallbackModelId: string;
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

function publish(
  eventBus: ExecutionEventBus,
  contextId: string,
  text: string
): void {
  const reply: Message = {
    kind: "message",
    messageId: crypto.randomUUID(),
    role: "agent",
    parts: [{ kind: "text", text }],
    contextId
  };
  eventBus.publish(reply);
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
  let modelId = cfg.primaryModelId;

  try {
    const {
      session,
      systemSuffix,
      tools: extraTools
    } = await cfg.prepare(text, metadata);

    await session.appendMessage(userSessionMessage(text));
    const history = await session.getHistory();
    const system = (await session.refreshSystemPrompt()) + systemSuffix;
    const tools = { ...(await session.tools()), ...extraTools };

    const generateArgs = {
      system,
      messages: toModelMessages(history),
      tools,
      stopWhen: stepCountIs(MAX_STEPS)
    };

    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({ model: cfg.model, ...generateArgs });
    } catch (primaryErr) {
      console.warn(
        "[agent-loop] AI error on primary model, retrying with fallback",
        {
          model: modelId,
          error: String(primaryErr),
          contextId: requestContext.contextId
        }
      );
      modelId = cfg.fallbackModelId;
      result = await generateText({
        model: cfg.fallbackModel,
        ...generateArgs
      });
    }

    const replyText = result.text.trim() || "Done.";
    await session.appendMessage(assistantSessionMessage(replyText));
    publish(eventBus, requestContext.contextId, replyText);
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
    publish(eventBus, requestContext.contextId, reply);
  } finally {
    eventBus.finished();
  }
}
