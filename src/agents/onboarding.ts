import type { AgentCard } from "@a2a-js/sdk";
import type { AgentExecutor } from "@a2a-js/sdk/server";
import { buildAgentCard } from "@/a2a/card";
import { EchoExecutor } from "@/a2a/echo-executor";
import { A2AAgent } from "./base";

/**
 * Onboarding (DM) concierge. Phase 3 echoes; Phase 5 adds the concierge AI loop
 * that explains the system, routes users, and surfaces health/recovery info.
 */
export class OnboardingAgent extends A2AAgent {
  protected card(): AgentCard {
    return buildAgentCard({
      name: "Onboarding Agent",
      description:
        "Looping onboarding concierge — explains the system and routes users (Phase 3 echo stub)."
    });
  }

  protected executor(): AgentExecutor {
    return new EchoExecutor();
  }
}
