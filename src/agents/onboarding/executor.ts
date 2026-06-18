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
import { callerContext } from "@/agents/shared/prompt";
import { onboardingSoul } from "./prompt";
import { buildOnboardingTools } from "./tools";

const COMPACT_AFTER_TOKENS = 60_000;

/** Test seams — production uses the defaults (real model + Sessions store). */
export interface OnboardingExecutorOptions extends ModelOverrides {
  createSession?: () => SessionLike;
}

/**
 * The onboarding concierge's behavior: a Workers-AI tool loop with per-user
 * memory. One `Session` per Durable Object (= one per user, `onboarding:{userId}`),
 * so a generic concierge `"soul"` + a writable SQLite `"memory"` scratchpad about
 * that user evolve in isolation. The generic turn mechanics live in
 * `@/agents/shared/loop`; this class supplies the session, the read-only
 * `directory_read` tool, and the caller context.
 */
export class OnboardingAgentExecutor implements AgentExecutor {
  private session?: SessionLike;
  private readonly models: ReturnType<typeof createModelPair>;

  constructor(
    private readonly agent: SessionHost,
    private readonly env: Env,
    private readonly options: OnboardingExecutorOptions = {}
  ) {
    this.models = createModelPair(this.env, this.options);
  }

  /** Lazily build the one Session for this DO (one per user). */
  private getSession(): SessionLike {
    if (!this.session) {
      this.session = this.options.createSession
        ? this.options.createSession()
        : buildAgentSession(this.agent, this.models.primary(), {
            soul: onboardingSoul,
            memoryDescription:
              "Durable facts about this user — their name, role, and what they're trying to set up. Keep it concise.",
            memoryMaxTokens: 1000,
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
      models: this.models,
      unexpectedReply:
        "Sorry, I hit an unexpected error. Please try again in a moment.",
      prepare: async (_text, metadata) => {
        // Validate the deserialized wire metadata at this boundary.
        if (metadata.agentKind !== "onboarding") {
          throw new Error("[onboarding-executor] expected onboarding metadata");
        }
        const ctx = metadata.user ?? null;
        return {
          session: this.getSession(),
          systemSuffix: callerContext(ctx),
          tools: buildOnboardingTools({ db: getDb(this.env), ctx })
        };
      }
    });
  };

  // A2A cancellation isn't supported for this single-shot loop.
  cancelTask = async (): Promise<void> => {};
}
