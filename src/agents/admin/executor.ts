import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext
} from "@a2a-js/sdk/server";
import type { Message } from "@a2a-js/sdk";
import type { LanguageModel, ToolSet } from "ai";
import { generateText, stepCountIs } from "ai";
import { Session } from "agents/experimental/memory/session";
import type { SessionMessage } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { textOf } from "@/a2a/parts";
import { getDb } from "@/db/client";
import { chatModel, fallbackChatModel } from "@/agents/model";
import { CHAT_MODEL_ID, CHAT_FALLBACK_MODEL_ID } from "@/config";

function isTransientAiError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes("3040") ||
    err.message.includes("3046") ||
    err.message.toLowerCase().includes("capacity temporarily exceeded") ||
    err.message.toLowerCase().includes("request timeout")
  );
}
import type { DispatchMetadata } from "@/agents/dispatch";
import { adminSoul, callerContext } from "./prompt";
import { buildAdminTools } from "./tools";
import {
  assistantSessionMessage,
  toModelMessages,
  userSessionMessage
} from "./messages";

/**
 * The SQLite-backed host the Sessions API needs — satisfied by the Agents SDK
 * `Agent` (`this.sql`). `env` is passed separately because it's `protected` on
 * `Agent` (only the agent subclass itself can read it).
 */
export interface SessionHost {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

/** The subset of `Session` the loop drives — lets tests inject a fake. */
export interface SessionLike {
  appendMessage(
    message: SessionMessage,
    parentId?: string | null
  ): Promise<unknown> | unknown;
  getHistory(): Promise<SessionMessage[]>;
  refreshSystemPrompt(): Promise<string>;
  tools(): Promise<ToolSet>;
}

/** Test seams — production uses the defaults (real model + Sessions store). */
export interface AdminExecutorOptions {
  model?: LanguageModel;
  createSession?: (wsId: number) => SessionLike;
}

const MAX_STEPS = 8;
const COMPACT_AFTER_TOKENS = 60_000;

/**
 * The admin agent's behavior: a Workers-AI tool loop with per-workspace memory.
 *
 * One `Session` per Durable Object (= one per workspace, `admin:{wsId}`), so a
 * `"soul"` identity block + a writable SQLite `"memory"` scratchpad evolve in
 * isolation. Each A2A request appends the user turn, runs `generateText` over the
 * session history with the registry/workspace tools (plus the Sessions
 * `set_context` memory tool), persists the final reply, and publishes it.
 */
export class AdminAgentExecutor implements AgentExecutor {
  private session?: SessionLike;
  private model?: LanguageModel;

  constructor(
    private readonly agent: SessionHost,
    private readonly env: Env,
    private readonly options: AdminExecutorOptions = {}
  ) {}

  private getModel(): LanguageModel {
    if (!this.model) this.model = this.options.model ?? chatModel(this.env);
    return this.model;
  }

  /** Lazily build the one Session for this DO; `wsId` is fixed per instance. */
  private getSession(wsId: number): SessionLike {
    if (!this.session) {
      this.session = this.options.createSession
        ? this.options.createSession(wsId)
        : this.defaultSession(wsId);
    }
    return this.session;
  }

  private defaultSession(wsId: number): Session {
    const model = this.getModel();
    return Session.create(this.agent)
      .withContext("soul", { provider: { get: async () => adminSoul(wsId) } })
      .withContext("memory", {
        description:
          "Durable facts about this workspace — who the admins are, conventions, and decisions. Keep it concise.",
        maxTokens: 1200
      })
      .onCompaction(
        createCompactFunction({
          summarize: (prompt) =>
            generateText({ model, prompt }).then((r) => r.text)
        })
      )
      .compactAfter(COMPACT_AFTER_TOKENS);
  }

  execute = async (
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> => {
    const userMessage = requestContext.userMessage;
    const text = textOf(userMessage);
    const metadata = (userMessage.metadata ?? {}) as Partial<DispatchMetadata>;
    const ctx = metadata.user ?? null;
    if (metadata.workspaceId == null) {
      throw new Error(
        "[admin-executor] workspaceId is required in metadata for admin agents"
      );
    }
    const wsId = metadata.workspaceId;
    let modelId = CHAT_MODEL_ID;

    try {
      const session = this.getSession(wsId);
      await session.appendMessage(userSessionMessage(text));

      const history = await session.getHistory();

      const system =
        (await session.refreshSystemPrompt()) + callerContext(ctx, wsId);
      const db = getDb(this.env);
      const adminTools = buildAdminTools({ db, ctx, wsId });
      const sessionTools = await session.tools();
      const tools = { ...sessionTools, ...adminTools };

      const generateArgs = {
        system,
        messages: toModelMessages(history),
        tools,
        stopWhen: stepCountIs(MAX_STEPS)
      };

      let result;
      try {
        result = await generateText({
          model: this.getModel(),
          ...generateArgs
        });
      } catch (primaryErr) {
        console.warn(
          "[admin-executor] AI error on primary model, retrying with fallback",
          {
            model: modelId,
            error: String(primaryErr),
            wsId,
            contextId: requestContext.contextId
          }
        );
        modelId = CHAT_FALLBACK_MODEL_ID;
        result = await generateText({
          model: fallbackChatModel(this.env),
          ...generateArgs
        });
      }

      const replyText = result.text.trim() || "Done.";
      await session.appendMessage(assistantSessionMessage(replyText));
      this.publish(eventBus, requestContext.contextId, replyText);
    } catch (err) {
      console.error("[admin-executor] execute failed", {
        wsId,
        contextId: requestContext.contextId,
        model: modelId,
        err: String(err),
        stack: err instanceof Error ? err.stack : undefined
      });
      const reply = isTransientAiError(err)
        ? "The AI service is temporarily unavailable. Please try again in a moment."
        : "Sorry, I hit an unexpected error handling that admin request. Please reach out to your developer and check the error logs for more details.";
      this.publish(eventBus, requestContext.contextId, reply);
    } finally {
      eventBus.finished();
    }
  };

  private publish(
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

  // A2A cancellation isn't supported for this single-shot loop.
  cancelTask = async (): Promise<void> => {};
}
