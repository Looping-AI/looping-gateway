import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext
} from "@a2a-js/sdk/server";
import { getDb } from "@/db/client";
import { createModelPair, type ModelOverrides } from "@/agents/model";
import {
  buildAgentSession,
  type SessionHost,
  type SessionLike
} from "@/agents/shared/session";
import { executeAgentTurn } from "@/agents/shared/loop";
import { archiveMessages } from "@/agents/shared/recall";
import { recallTools } from "@/agents/shared/recall-tool";
import { verifyRemoteAgentEndpoint } from "@/a2a/card-verify";
import { getAllowedRemoteAgentDomains } from "@/db/models/workspace-configs";
import { adminSoul, callerContext } from "./prompt";
import { buildAdminTools } from "./tools";
import { generateAvatar, type GeneratedImage } from "./avatar";

// Re-exported so existing test imports (`@/agents/admin/executor`) keep working.
export type { SessionHost, SessionLike } from "@/agents/shared/session";

const COMPACT_AFTER_TOKENS = 60_000;

/** Test seams — production uses the defaults (real model + Sessions store). */
export interface AdminExecutorOptions extends ModelOverrides {
  createSession?: (wsId: number) => SessionLike;
  /**
   * Persist a generated avatar in the agent's DO storage, returning its key.
   * `name` is `"admin"` (the admin's own avatar) or a custom agent's name, so each
   * agent's icons are pruned independently. Injected by {@link AdminAgent} (bound to
   * its DO storage); when absent, avatar generation is unavailable.
   */
  storeIcon?: (
    img: GeneratedImage,
    name: string
  ) => Promise<{ key: string; contentType: string }>;
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
  private readonly models: ReturnType<typeof createModelPair>;

  constructor(
    private readonly agent: SessionHost,
    private readonly env: Env,
    private readonly options: AdminExecutorOptions = {}
  ) {
    this.models = createModelPair(this.env, this.options);
  }

  /** Lazily build the one Session for this DO; `wsId` is fixed per instance. */
  private getSession(wsId: number): SessionLike {
    if (!this.session) {
      // Must match `instanceNameFor` in dispatch.ts (the DO instance key).
      const namespace = `admin:${wsId}`;
      this.session = this.options.createSession
        ? this.options.createSession(wsId)
        : buildAgentSession(this.agent, this.models.primary(), {
            soul: () => adminSoul(wsId),
            memoryDescription:
              "Durable facts about this workspace — who the admins are, conventions, and decisions. Keep it concise.",
            memoryMaxTokens: 1200,
            compactAfterTokens: COMPACT_AFTER_TOKENS,
            onArchive: (msgs) => archiveMessages(this.env, namespace, msgs)
          });
    }
    return this.session;
  }

  execute = async (
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> => {
    await executeAgentTurn(requestContext, eventBus, {
      models: this.models,
      unexpectedReply:
        "Sorry, I hit an unexpected error handling that admin request. Please reach out to your developer and check the error logs for more details.",
      prepare: async (_text, metadata) => {
        // Validate the deserialized wire metadata at this boundary. Both the
        // workspace id and the Slack user are guaranteed preconditions (the
        // classifier drops sender-less events), so treat them as required.
        if (
          metadata.agentKind !== "admin" ||
          metadata.adminWorkspaceId == null ||
          metadata.user == null
        ) {
          throw new Error(
            "[admin-executor] expected admin metadata with an adminWorkspaceId and user"
          );
        }
        const wsId = metadata.adminWorkspaceId;
        const ctx = metadata.user;
        const session = this.getSession(wsId);
        const namespace = `admin:${wsId}`;
        const hasArchive = (await session.getCompactions()).length > 0;
        return {
          session,
          systemSuffix: callerContext(ctx, { workspaceId: wsId }),
          tools: {
            ...buildAdminTools({
              db: getDb(this.env),
              ctx,
              wsId,
              verifyEndpoint: async (endpoint) => {
                const allowedDomains = await getAllowedRemoteAgentDomains(
                  getDb(this.env)
                );
                return verifyRemoteAgentEndpoint(endpoint, allowedDomains);
              },
              generateImage: (prompt) => generateAvatar(this.env, prompt),
              storeIcon: this.options.storeIcon
            }),
            ...recallTools(this.env, namespace, hasArchive)
          }
        };
      }
    });
  };

  // A2A cancellation isn't supported for this single-shot loop.
  cancelTask = async (): Promise<void> => {};
}
