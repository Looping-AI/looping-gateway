import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext
} from "@a2a-js/sdk/server";
import type { LanguageModel } from "ai";
import { getDb } from "@/db/client";
import { chatModel, fallbackChatModel } from "@/agents/model";
import { CHAT_MODEL_ID, CHAT_FALLBACK_MODEL_ID } from "@/config";
import {
  buildAgentSession,
  type SessionHost,
  type SessionLike
} from "@/agents/shared/session";
import { executeAgentTurn } from "@/agents/shared/loop";
import { adminSoul, callerContext } from "./prompt";
import { buildAdminTools } from "./tools";

// Re-exported so existing test imports (`@/agents/admin/executor`) keep working.
export type { SessionHost, SessionLike } from "@/agents/shared/session";

const COMPACT_AFTER_TOKENS = 60_000;

/** Test seams — production uses the defaults (real model + Sessions store). */
export interface AdminExecutorOptions {
  model?: LanguageModel;
  createSession?: (wsId: number) => SessionLike;
}

/**
 * The admin agent's behavior: a Workers-AI tool loop with per-workspace memory.
 *
 * One `Session` per Durable Object (= one per workspace, `admin:{wsId}`), so a
 * `"soul"` identity block + a writable SQLite `"memory"` scratchpad evolve in
 * isolation. The generic turn mechanics live in `@/agents/shared/loop`; this
 * class only supplies the per-workspace session, the registry/workspace tools,
 * and the caller context.
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
        : buildAgentSession(this.agent, this.getModel(), {
            soul: () => adminSoul(wsId),
            memoryDescription:
              "Durable facts about this workspace — who the admins are, conventions, and decisions. Keep it concise.",
            memoryMaxTokens: 1200,
            compactAfterTokens: COMPACT_AFTER_TOKENS
          });
    }
    return this.session;
  }

  execute = async (
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> => {
    await executeAgentTurn(requestContext, eventBus, {
      model: this.getModel(),
      fallbackModel: this.options.model ?? fallbackChatModel(this.env),
      primaryModelId: CHAT_MODEL_ID,
      fallbackModelId: CHAT_FALLBACK_MODEL_ID,
      unexpectedReply:
        "Sorry, I hit an unexpected error handling that admin request. Please reach out to your developer and check the error logs for more details.",
      prepare: async (_text, metadata) => {
        // Validate the deserialized wire metadata at this boundary.
        if (
          metadata.agentKind !== "admin" ||
          metadata.adminWorkspaceId == null
        ) {
          throw new Error(
            "[admin-executor] expected admin metadata with an adminWorkspaceId"
          );
        }
        const wsId = metadata.adminWorkspaceId;
        const ctx = metadata.user ?? null;
        return {
          session: this.getSession(wsId),
          systemSuffix: callerContext(ctx, { workspaceId: wsId }),
          tools: buildAdminTools({ db: getDb(this.env), ctx, wsId })
        };
      }
    });
  };

  // A2A cancellation isn't supported for this single-shot loop.
  cancelTask = async (): Promise<void> => {};
}
