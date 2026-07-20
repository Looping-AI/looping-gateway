import type { Message } from "@a2a-js/sdk";
import type { UserAuthContext } from "@/auth";
import { env } from "cloudflare:workers";
import { signGatewayToken, type RemoteIdentity } from "@/auth/agent-outbound";
import type { AgentRow } from "@/db/models/agents";
import { buildAgentCard } from "@/a2a/card";
import { localPushNotificationConfig } from "@/a2a/notifications/local";
import {
  sendA2ALocal,
  sendA2ARemote,
  cancelA2ARemote,
  type CancelOutcome
} from "@/a2a/client";
import { originOf, validateRemoteEndpoint } from "@/a2a/endpoint";
import {
  getAllowedRemoteAgentDomains,
  getPublicUrl
} from "@/db/models/workspace-configs";
import { renderTurn, turnContextFromPayload } from "@/agents/shared/messages";

/** The subset of an agent registry row the dispatcher needs (Rpc-serializable). */
export interface DispatchAgentRef {
  name: string;
  kind: AgentRow["kind"];
  a2aEndpoint: string;
  workspaceId: number;
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
  | { agentKind: "custom"; workspaceId: number };

/**
 * What rides on the A2A `message.metadata` and what the executor reads back.
 * Who/where/when is carried in the turn *text* (the Gateway-applied `<turn>`
 * wrapper), not here — this is only the caller (`user`, for authorization) plus
 * the per-kind routing extras.
 */
export type AgentTurnMetadata = { user: UserAuthContext } & DispatchMetadata;

export interface DispatchPayload {
  /**
   * Slack `event_id` of the triggering delivery — the idempotency anchor. Folded
   * with the agent instance into a deterministic {@link buildDispatchId} so a
   * re-dispatch (workflow-step retry) carries the same A2A `messageId` and push
   * `token`; a conformant remote dedupes on the `messageId` instead of appending
   * the turn twice.
   */
  eventId: string;
  /** Original user text. */
  text: string;
  /** Slack channel id — combined with `threadTs` into the A2A `contextId`. */
  channelId: string;
  /** Resolved human channel name (`general`), or null when unresolved / a DM. */
  channelName: string | null;
  /** Thread timestamp (or message `ts` for top-level) — the thread key. */
  threadTs: string;
  /** Slack message timestamp of the originating user turn. */
  messageTs: string;
  /** The caller — ALWAYS present (the classifier boundary guarantees it). */
  user: UserAuthContext;
  /** Only the per-kind extras; merged with `user` onto the wire metadata. */
  metadata: DispatchMetadata;
}

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
async function resolveIssuer(): Promise<string | null> {
  if (cachedIssuer !== null) return cachedIssuer;
  const issuer = await getPublicUrl();
  if (issuer) cachedIssuer = issuer;
  return issuer;
}

/** Stable per-thread A2A context id, e.g. `"{channelId}:{threadTs}"`. */
export const buildContextId = (channelId: string, threadTs: string): string =>
  `${channelId}:${threadTs}`;

/** Encode bytes as a fixed-length lowercase-alphanumeric (base36) id. */
function base36Id(bytes: Uint8Array, length: number): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n.toString(36).padStart(length, "0").slice(-length);
}

/**
 * Deterministic per-dispatch id: `SHA-256({eventId}:{kind}:{workspaceId}:{name})`
 * truncated to 96 bits and base36-encoded → a compact 19-char alphanumeric token
 * (e.g. `k3n7p2q9x4m8r5t6w1a`). Used verbatim as the A2A `messageId` (a conformant
 * remote dedupes on it) and the push `token` (so a retried dispatch reuses one
 * `agent_tasks` row and one callback target). Same inputs ⇒ same id ⇒ safe to
 * re-send; 96 bits makes a collision within the short-lived task set negligible,
 * and hashing means the id exposes neither the Slack event id nor the agent key.
 */
export async function buildDispatchId(
  eventId: string,
  agent: Pick<DispatchAgentRef, "kind" | "workspaceId" | "name">
): Promise<string> {
  const input = `${eventId}:${buildAgentInstanceKey(agent)}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
  );
  return base36Id(digest.subarray(0, 12), 19);
}

/**
 * Stable remote caller key derived from the registered agent row. The endpoint
 * is intentionally excluded so multiple logical agents can safely share it.
 */
export function buildAgentInstanceKey(
  agent: Pick<DispatchAgentRef, "kind" | "workspaceId" | "name">
): string {
  return `${agent.kind}:${agent.workspaceId}:${agent.name}`;
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
 * The outcome of a dispatch. All agents accept a Task here and deliver their real
 * reply later: remote agents call the authenticated public callback, while local
 * built-ins use a trusted in-process sender. The workflow receives the shared
 * correlation `token` and the assigned `taskId`; a contract violation (a reply
 * that isn't a Task acceptance) is surfaced as a visible error reply.
 */
export type DispatchResult =
  | { kind: "error_reply"; text: string }
  | { kind: "accepted"; token: string; taskId: string };

/**
 * Dispatch a user message to an agent over A2A. Routing is by `agent.kind`:
 * built-in local agents are reached in-process via their DO `stub.fetch`; custom
 * agents go over real HTTP at their `a2aEndpoint`. Both return task acceptance
 * and deliver status snapshots through their respective push-notification path.
 */
export async function dispatchToAgent(
  agent: DispatchAgentRef,
  payload: DispatchPayload
): Promise<DispatchResult> {
  const localContextId = buildContextId(payload.channelId, payload.threadTs);
  const bindingName = LOCAL_BINDINGS[agent.kind];

  // Deterministic per-dispatch id → the A2A `messageId` (dedupe key) and, for
  // remotes, the push `token`. Stable across retries so re-delivery is idempotent.
  const dispatchId = await buildDispatchId(payload.eventId, agent);

  // The Gateway owns provenance: who/where/when is inlined into the turn text via
  // the `<turn>` wrapper, once, identically for local and remote agents. Nothing
  // structured rides alongside — downstream agents (and the recall archiver) read
  // it back from the text. See renderTurn / parseTurn in shared/messages.
  const text = renderTurn(payload.text, turnContextFromPayload(payload));

  if (!bindingName) {
    // Custom agent → real HTTP. The caller's identity travels in a short-lived,
    // EdDSA-signed gateway JWT (verified by the remote against our public JWKS),
    // NOT as plaintext `message.metadata` — so a remote agent can neither read
    // the full `UserAuthContext` nor forge the caller's permissions.
    const allowedDomains = await getAllowedRemoteAgentDomains();
    validateRemoteEndpoint(agent.a2aEndpoint, allowedDomains); // SSRF + approved-domain defense-in-depth

    const identity = buildRemoteIdentity(agent);
    const issuer = await resolveIssuer();
    if (!issuer) {
      throw new Error(
        "Gateway public URL has not been discovered yet. " +
          "Ensure the worker has received at least one Slack event before registering remote agents."
      );
    }
    const gatewayToken = await signGatewayToken({
      audience: originOf(agent.a2aEndpoint),
      issuer,
      identity
    });

    const remoteMessage: Message = {
      kind: "message",
      // Deterministic id so a retried dispatch is dedupable by the remote rather
      // than appended as a fresh turn (A2A `messageId` is the sender-set dedupe key).
      messageId: dispatchId,
      role: "user",
      parts: [{ kind: "text", text }],
      contextId: buildRemoteContextId(
        identity,
        payload.channelId,
        payload.threadTs
      ),
      // The signed token is the only authority — it names the calling
      // gateway-agent instance, not any Slack user. The turn's who/where/when
      // lives in the `<turn>` text; no gateway authorization or permission
      // context ever crosses this boundary.
      metadata: { ...payload.metadata }
    };

    // Push-notification validation token = the same deterministic dispatch id. The
    // remote echoes it on the callback so the gateway correlates it to the pending
    // task (A2A §13.2); the webhook still verifies the remote's signature against
    // its pinned card key (that JWT is the real authenticator — this token is the
    // correlation/dedupe key, stable across retries so they collapse to one row).
    const accept = await sendA2ARemote(
      { endpoint: agent.a2aEndpoint, authToken: gatewayToken },
      remoteMessage,
      { url: `${issuer}/a2a/notifications`, token: dispatchId }
    );
    if (accept.kind === "accepted") {
      return { kind: "accepted", token: dispatchId, taskId: accept.taskId };
    }
    return {
      kind: "error_reply",
      text: "Remote agent did not provide the required task acknowledgment."
    };
  }

  // Local agent → in-process via DO stub.fetch. Trusted same-worker dispatch, so
  // the full caller context rides on the message metadata (for authorization);
  // provenance still travels in the `<turn>` text like every other agent.
  const metadata: AgentTurnMetadata = {
    user: payload.user,
    ...payload.metadata
  };
  const message: Message = {
    kind: "message",
    // Deterministic id (same dedupe rationale as the remote path).
    messageId: dispatchId,
    role: "user",
    parts: [{ kind: "text", text }],
    contextId: localContextId,
    metadata: { ...metadata }
  };

  const instanceName = instanceNameFor(metadata);

  const ns = (env as unknown as Record<string, unknown>)[
    bindingName
  ] as DurableObjectNamespace;
  const stub = ns.get(ns.idFromName(instanceName));
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    stub.fetch(input as RequestInfo, init)) as typeof fetch;
  const card = buildAgentCard({
    name: agent.name,
    description: `Local ${agent.kind} agent`,
    pushNotifications: true
  });

  const accept = await sendA2ALocal(
    { card, fetchImpl },
    message,
    localPushNotificationConfig(dispatchId)
  );
  if (accept.kind === "accepted") {
    return { kind: "accepted", token: dispatchId, taskId: accept.taskId };
  }
  return {
    kind: "error_reply",
    text: "Local agent did not provide the required task acknowledgment."
  };
}

/**
 * Ask an agent to cancel an in-flight task via the standard A2A `tasks/cancel`.
 * Mirrors the remote branch of {@link dispatchToAgent}: SSRF/allowlist validation
 * plus a freshly signed gateway-identity JWT (audience = the endpoint origin),
 * then the cancel call. The response is authoritative — the gateway reconciles
 * from it and expects no push callback afterwards.
 *
 * Local built-ins run as a single blocking turn (no concurrent request can
 * interrupt them and they finish in seconds), so cancellation is a no-op for
 * them in v1 — reported as `not_cancelable` so the caller still reconciles its
 * ledger row without contacting anything.
 */
export async function cancelAgentTask(
  agent: DispatchAgentRef,
  taskId: string
): Promise<CancelOutcome> {
  if (LOCAL_BINDINGS[agent.kind]) {
    return { kind: "not_cancelable" };
  }

  const allowedDomains = await getAllowedRemoteAgentDomains();
  validateRemoteEndpoint(agent.a2aEndpoint, allowedDomains);

  const issuer = await resolveIssuer();
  if (!issuer) {
    throw new Error(
      "Gateway public URL has not been discovered yet; cannot sign a cancel request."
    );
  }
  const gatewayToken = await signGatewayToken({
    audience: originOf(agent.a2aEndpoint),
    issuer,
    identity: buildRemoteIdentity(agent)
  });

  return cancelA2ARemote(
    { endpoint: agent.a2aEndpoint, authToken: gatewayToken },
    taskId
  );
}
