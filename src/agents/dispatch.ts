import type { Message } from "@a2a-js/sdk";
import type { UserAuthContext } from "@/auth";
import type { AgentRow } from "@/db/models/agents";
import { buildAgentCard } from "@/a2a/card";
import { sendA2AMessage } from "@/a2a/client";

/** The subset of an agent registry row the dispatcher needs (Rpc-serializable). */
export interface DispatchAgentRef {
  name: string;
  kind: AgentRow["kind"];
  a2aEndpoint: string | null;
}

/** Routing + auth context carried to the agent on `message.metadata`. */
export interface DispatchMetadata {
  user: UserAuthContext | null;
  channelId: string;
  workspaceId: number | null;
  slackTeamId: string | null;
  eventId: string;
}

export interface DispatchPayload {
  /** Cleaned user text (bot mention + `::ref` stripped). */
  text: string;
  /** Stable per-thread id, e.g. `"{channelId}:{threadTs}"`. */
  contextId: string;
  metadata: DispatchMetadata;
}

// Built-in local agents map their `kind` to a Durable Object namespace binding.
// Custom agents are remote and addressed by `a2aEndpoint` instead.
const LOCAL_BINDINGS: Partial<Record<AgentRow["kind"], keyof Env>> = {
  admin: "AdminAgent",
  onboarding: "OnboardingAgent"
};

/**
 * Durable Object instance name for a local agent. The admin agent runs **one
 * instance per workspace** (`admin:0` = org, `admin:1`, …) so each has its own
 * SQLite — isolated Sessions + memory. Other kinds use a single instance keyed
 * by name (onboarding may move to per-user in Phase 5).
 */
export function instanceNameFor(
  agent: DispatchAgentRef,
  metadata: DispatchMetadata
): string {
  if (agent.kind === "admin") {
    if (metadata.workspaceId == null) {
      throw new Error(
        "[dispatch] workspaceId is required in metadata for admin agents"
      );
    }
    return `admin:${metadata.workspaceId}`;
  }
  return agent.name;
}

/**
 * Dispatch a user message to an agent over A2A and return its reply text.
 * Local built-in agents are reached in-process via their DO `stub.fetch`; remote
 * custom agents (with an `a2aEndpoint`) go over real HTTP (Phase 7).
 */
export async function dispatchToAgent(
  env: Env,
  agent: DispatchAgentRef,
  payload: DispatchPayload
): Promise<string> {
  const message: Message = {
    kind: "message",
    messageId: crypto.randomUUID(),
    role: "user",
    parts: [{ kind: "text", text: payload.text }],
    contextId: payload.contextId,
    metadata: { ...payload.metadata }
  };

  if (agent.a2aEndpoint) {
    const reply = await sendA2AMessage(
      { kind: "remote", endpoint: agent.a2aEndpoint },
      message
    );
    return reply;
  }

  const bindingName = LOCAL_BINDINGS[agent.kind];
  if (!bindingName) {
    throw new Error(
      `No local A2A binding for agent "${agent.name}" (kind="${agent.kind}") and no a2aEndpoint set`
    );
  }

  const instanceName = instanceNameFor(agent, payload.metadata);

  const ns = env[bindingName] as DurableObjectNamespace;
  const stub = ns.get(ns.idFromName(instanceName));
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    stub.fetch(input as RequestInfo, init)) as typeof fetch;
  const card = buildAgentCard({
    name: agent.name,
    description: `Local ${agent.kind} agent`
  });

  const reply = await sendA2AMessage(
    { kind: "local", card, fetchImpl },
    message
  );
  return reply;
}
