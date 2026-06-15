import type { AgentCard } from "@a2a-js/sdk";
import type { AgentExecutor } from "@a2a-js/sdk/server";
import { buildAgentCard } from "@/a2a/card";
import { EchoExecutor } from "@/a2a/echo-executor";
import { A2AAgent } from "./base";

/**
 * Admin agent (registry + workspace management). Phase 3 echoes; Phase 4 adds
 * the AI-SDK loop + registry/workspace tools gated by the caller's auth context.
 */
export class AdminAgent extends A2AAgent {
  protected card(): AgentCard {
    return buildAgentCard({
      name: "Admin Agent",
      description:
        "Looping admin agent — manages the registry and workspaces (Phase 3 echo stub)."
    });
  }

  protected executor(): AgentExecutor {
    return new EchoExecutor();
  }
}
