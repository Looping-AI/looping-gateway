import type { AgentCard } from "@a2a-js/sdk";

/**
 * Placeholder JSON-RPC endpoint path baked into locally-built agent cards. When
 * an agent is reached in-process via a Durable Object `stub.fetch`, the host is
 * irrelevant — the DO answers every POST as JSON-RPC regardless of path — so any
 * absolute URL parses fine and routes correctly. Remote agents (Phase 7) supply
 * their own real card via discovery instead.
 */
const PLACEHOLDER_BASE_URL = "https://agent.local";
export const A2A_ENDPOINT_PATH = "/a2a";

export interface AgentCardInput {
  name: string;
  description: string;
  /** Override the endpoint URL (remote agents). Defaults to the local placeholder. */
  url?: string;
  /** Whether this agent accepts A2A push-notification configuration. */
  pushNotifications?: boolean;
}

/**
 * Build a minimal A2A AgentCard for a local in-repo agent. JSON-RPC is the only
 * transport. Streaming is off; built-ins opt into local push notifications.
 */
export function buildAgentCard(input: AgentCardInput): AgentCard {
  return {
    name: input.name,
    description: input.description,
    protocolVersion: "0.3.0",
    version: "0.1.0",
    url: input.url ?? `${PLACEHOLDER_BASE_URL}${A2A_ENDPOINT_PATH}`,
    preferredTransport: "JSONRPC",
    capabilities: {
      streaming: false,
      pushNotifications: input.pushNotifications ?? false
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "chat",
        name: "Chat",
        description: input.description,
        tags: ["chat"]
      }
    ]
  };
}
