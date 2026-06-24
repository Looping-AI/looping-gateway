import type { Message } from "@a2a-js/sdk";
import type { UserAuthContext } from "@/auth";
import { signGatewayToken, type RemoteIdentity } from "@/auth/agent-jwt";
import type { AgentRow } from "@/db/models/agents";
import { buildAgentCard } from "@/a2a/card";
import { sendA2AMessage } from "@/a2a/client";
import { originOf, validateRemoteEndpoint } from "@/a2a/endpoint";
import { getDb } from "@/db/client";
import {
  getAllowedRemoteAgentDomains,
  getPublicUrl
} from "@/db/models/workspace-configs";

/** The subset of an agent registry row the dispatcher needs (Rpc-serializable). */
export interface DispatchAgentRef {
  name: string;
  kind: AgentRow["kind"];
  a2aEndpoint: string;
  workspaceId: number | null;
}

/**
 * The per-kind routing extras carried alongside the caller. The universal
 * `user` lives on {@link DispatchPayload}; this union holds only the fields that
 * differ by agent kind. `agentKind` is the discriminant the executor narrows on
 * (it reads deserialized JSON and has no access to {@link DispatchAgentRef}).
 */
export type DispatchMetadata =
  | { agentKind: "admin"; adminWorkspaceId: number }
  | { agentKind: "onboarding" }
  | { agentKind: "custom"; workspaceId: number | null };

/** What rides on the A2A `message.metadata` and what the executor reads back. */
export type AgentTurnMetadata = { user: UserAuthContext } & DispatchMetadata;

export interface DispatchPayload {
  /** Cleaned user text (bot mention + `::ref` stripped). */
  text: string;
  /** Slack channel id — combined with `threadTs` into the A2A `contextId`. */
  channelId: string;
  /** Thread timestamp (or message `ts` for top-level) — the thread key. */
  threadTs: string;
  /** Slack message timestamp of the originating user turn. */
  messageTs: string;
  /** The caller — ALWAYS present (the classifier boundary guarantees it). */
  user: UserAuthContext;
  /** Only the per-kind extras; merged with `user` onto the wire metadata. */
  metadata: DispatchMetadata;
}

const ORG_WIDE_AGENT_SCOPE = "org";

/**
 * Isolate-level memo of the gateway's public origin (the JWT `iss` + `jku` host).
 * Written to D1 by the fetch isolate on first verified Slack request; the Workflow
 * isolate reads it once here and caches it for its lifetime. Resets on cold start
 * (redeploy / domain change), so a changed origin is picked up by the new isolate.
 */
let cachedIssuer: string | null = null;

/** Reset the isolate-level issuer cache. Only for test isolation. */
export function _resetIssuerCacheForTest(): void {
  cachedIssuer = null;
}

/** Read (and memoize) the gateway issuer origin from D1. */
async function resolveIssuer(env: Env): Promise<string | null> {
  if (cachedIssuer !== null) return cachedIssuer;
  const issuer = await getPublicUrl(getDb(env));
  if (issuer) cachedIssuer = issuer;
  return issuer;
}

/** Stable per-thread A2A context id, e.g. `"{channelId}:{threadTs}"`. */
export const buildContextId = (channelId: string, threadTs: string): string =>
  `${channelId}:${threadTs}`;

/**
 * Stable remote caller key derived from the registered agent row. The endpoint
 * is intentionally excluded so multiple logical agents can safely share it.
 */
export function buildAgentInstanceKey(
  agent: Pick<DispatchAgentRef, "kind" | "workspaceId" | "name">
): string {
  return `${agent.kind}:${agent.workspaceId ?? ORG_WIDE_AGENT_SCOPE}:${agent.name}`;
}

/** Canonical signed identity of the gateway-agent instance calling remotely. */
export function buildRemoteIdentity(
  agent: Pick<DispatchAgentRef, "kind" | "workspaceId" | "name">
): RemoteIdentity {
  return {
    key: buildAgentInstanceKey(agent),
    name: agent.name,
    kind: agent.kind,
    workspaceId: agent.workspaceId
  };
}

/**
 * Remote context id namespaces channel/thread history by the calling agent
 * instance so sibling agents sharing one endpoint never collide.
 */
export function buildRemoteContextId(
  identity: Pick<RemoteIdentity, "key">,
  channelId: string,
  threadTs: string
): string {
  return (
    `agent=${encodeURIComponent(identity.key)}` +
    `&channel=${encodeURIComponent(channelId)}` +
    `&thread=${encodeURIComponent(threadTs)}`
  );
}

/** Inverse of {@link buildContextId}; splits on the first `:` only. */
export function parseContextId(id: string): {
  channelId: string;
  threadTs: string;
} {
  if (id.startsWith("agent=")) {
    const params = new URLSearchParams(id);
    const channelId = params.get("channel");
    const threadTs = params.get("thread");
    if (!channelId || !threadTs) {
      throw new Error(
        `invalid remote context id (missing required params): ${id}`
      );
    }
    return {
      channelId,
      threadTs
    };
  }
  const sep = id.indexOf(":");
  return sep === -1
    ? { channelId: id, threadTs: "" }
    : { channelId: id.slice(0, sep), threadTs: id.slice(sep + 1) };
}

/**
 * Untrusted "who said what, when" attribution for a single turn, carried on the
 * remote `message.metadata`. A custom agent integrates turns from many channels
 * (and, later, many sources) into one history keyed by its own identity; this
 * lets it record per-turn authorship and ordering — the thing a flat `"user"`
 * role cannot express once a thread has multiple human actors.
 *
 * It is **provenance, not authority**: the gateway's authoritative caller
 * identity is the *agent instance* in the signed JWT (see {@link RemoteIdentity}).
 * Nothing here grants permissions, and a remote must treat it as caller-supplied.
 */
export interface RemoteProvenance {
  /** The channel type this turn originated from. */
  source: "slack";
  /** WHO authored the turn. */
  author: {
    /** Stable, source-qualified actor key (e.g. `slack:U123`) for attribution. */
    id: string;
    slackUserId: string;
    displayName: string | null;
  };
  /** WHERE — the channel the turn arrived on. */
  channelId: string;
  /** The thread key within {@link RemoteProvenance.channelId}. */
  threadTs: string;
  /** WHEN — Slack ts of this specific turn (sortable per channel). */
  messageTs: string;
}

function remoteProvenance(payload: DispatchPayload): RemoteProvenance {
  return {
    source: "slack",
    author: {
      id: `slack:${payload.user.slackUserId}`,
      slackUserId: payload.user.slackUserId,
      displayName: payload.user.displayName
    },
    channelId: payload.channelId,
    threadTs: payload.threadTs,
    messageTs: payload.messageTs
  };
}

// Built-in local agents map their `kind` to a Durable Object namespace binding.
// Routing is decided by `kind` (not the endpoint): a kind in this map is local,
// everything else (custom) is reached over HTTP at its `a2aEndpoint`.
const LOCAL_BINDINGS: Partial<Record<AgentRow["kind"], keyof Env>> = {
  admin: "AdminAgent",
  onboarding: "OnboardingAgent"
};

/**
 * Durable Object instance name for a local agent. The admin agent runs **one
 * instance per workspace** (`admin:0` = org, `admin:1`, …) and the onboarding
 * concierge runs **one instance per user** (`onboarding:{slackUserId}`), so each
 * has its own SQLite — isolated Sessions + memory. Other kinds use a single
 * instance keyed by name.
 */
export function instanceNameFor(metadata: AgentTurnMetadata): string {
  switch (metadata.agentKind) {
    case "admin":
      return `admin:${metadata.adminWorkspaceId}`;
    case "onboarding":
      return `onboarding:${metadata.user.slackUserId}`;
    default:
      throw new Error(
        `unreachable: unhandled agentKind '${metadata.agentKind}'`
      );
  }
}

/**
 * Dispatch a user message to an agent over A2A and return its reply text.
 * Routing is by `agent.kind`: built-in local agents are reached in-process via
 * their DO `stub.fetch`; custom agents go over real HTTP at their `a2aEndpoint`.
 */
export async function dispatchToAgent(
  env: Env,
  agent: DispatchAgentRef,
  payload: DispatchPayload
): Promise<string> {
  const localContextId = buildContextId(payload.channelId, payload.threadTs);
  const bindingName = LOCAL_BINDINGS[agent.kind];

  if (!bindingName) {
    // Custom agent → real HTTP. The caller's identity travels in a short-lived,
    // EdDSA-signed gateway JWT (verified by the remote against our public JWKS),
    // NOT as plaintext `message.metadata` — so a remote agent can neither read
    // the full `UserAuthContext` nor forge the caller's permissions.
    const allowedDomains = await getAllowedRemoteAgentDomains(getDb(env));
    validateRemoteEndpoint(agent.a2aEndpoint, allowedDomains); // SSRF + approved-domain defense-in-depth

    const identity = buildRemoteIdentity(agent);
    const issuer = await resolveIssuer(env);
    if (!issuer) {
      throw new Error(
        "Gateway public URL has not been discovered yet. " +
          "Ensure the worker has received at least one Slack event before registering remote agents."
      );
    }
    const token = await signGatewayToken(env, {
      audience: originOf(agent.a2aEndpoint),
      issuer,
      identity
    });

    const remoteMessage: Message = {
      kind: "message",
      messageId: crypto.randomUUID(),
      role: "user",
      parts: [{ kind: "text", text: payload.text }],
      contextId: buildRemoteContextId(
        identity,
        payload.channelId,
        payload.threadTs
      ),
      // The signed token is the only authority — it names the calling
      // gateway-agent instance, not any Slack user. `provenance` adds untrusted
      // "who/where/when" attribution for the remote's own history; no gateway
      // authorization or permission context ever crosses this boundary.
      metadata: {
        ...payload.metadata,
        provenance: remoteProvenance(payload)
      }
    };
    return sendA2AMessage(
      { kind: "remote", endpoint: agent.a2aEndpoint, authToken: token },
      remoteMessage
    );
  }

  // Local agent → in-process via DO stub.fetch. Trusted same-worker dispatch, so
  // the full caller context rides on the message metadata.
  const metadata: AgentTurnMetadata = {
    user: payload.user,
    ...payload.metadata
  };
  const message: Message = {
    kind: "message",
    messageId: crypto.randomUUID(),
    role: "user",
    parts: [{ kind: "text", text: payload.text }],
    contextId: localContextId,
    metadata: { ...metadata }
  };

  const instanceName = instanceNameFor(metadata);

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
