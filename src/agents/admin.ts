import type { AgentCard } from "@a2a-js/sdk";
import type { AgentExecutor } from "@a2a-js/sdk/server";
import { buildAgentCard } from "@/a2a/card";
import { A2AAgent } from "./base";
import { AdminAgentExecutor } from "./admin/executor";

/**
 * Admin agent (registry + workspace management). One Durable Object instance per
 * workspace (`admin:{wsId}`), each with isolated Sessions + memory. Runs a
 * Workers-AI tool loop over registry/workspace CRUD tools gated by the caller's
 * auth context (carried on `message.metadata`).
 */
export class AdminAgent extends A2AAgent {
  protected card(): AgentCard {
    return buildAgentCard({
      name: "Admin Agent",
      description:
        "Looping admin agent — manages the agent registry and workspaces."
    });
  }

  protected executor(): AgentExecutor {
    return new AdminAgentExecutor(this, this.env);
  }
}
