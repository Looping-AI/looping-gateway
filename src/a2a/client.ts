import {
  ClientFactory,
  ClientFactoryOptions,
  JsonRpcTransportFactory,
  type Client
} from "@a2a-js/sdk/client";
import type {
  AgentCard,
  Message,
  MessageSendParams,
  PushNotificationConfig
} from "@a2a-js/sdk";
import { extractText } from "./parts";

/**
 * Where to send an A2A message:
 * - `local`  — a known card + a `fetchImpl` bound to a Durable Object `stub.fetch`,
 *   so card discovery is skipped and the call runs in-process (no network hop).
 *   Local agents reply *synchronously* — {@link sendA2ALocal} returns their text.
 * - `remote` — a base URL; the card is discovered over real HTTP, every request
 *   carries the gateway identity JWT (`authToken`). Remote agents reply
 *   *asynchronously* via push notification — {@link acceptA2ARemote} only waits
 *   for the accept (a Task ack), never for generation.
 */
export interface A2ALocalTarget {
  kind: "local";
  card: AgentCard;
  fetchImpl: typeof fetch;
}
export interface A2ARemoteTarget {
  kind: "remote";
  endpoint: string;
  authToken?: string;
}

/**
 * Abort a remote *accept* that hangs. This only covers the initial handshake
 * (the remote must return a `submitted`/`working` Task immediately, A2A §7.2), not
 * generation — so it can be short. The reply itself arrives later via the
 * push-notification callback, so no gateway request ever blocks on the model.
 */
const ACCEPT_TIMEOUT_MS = 15_000;

/** Hard cap on a remote reply before it reaches Slack (untrusted output). */
const MAX_REMOTE_REPLY_CHARS = 16_000;

/**
 * Build a `fetchImpl` for a remote target: injects the gateway JWT as a Bearer
 * token on every request and enforces the short accept timeout. Reuses the same
 * `fetchImpl` override seam the local (DO stub) path uses.
 */
function remoteFetchImpl(authToken?: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (authToken) headers.set("authorization", `Bearer ${authToken}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ACCEPT_TIMEOUT_MS);
    try {
      return await fetch(input as RequestInfo, {
        ...init,
        headers,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }) as typeof fetch;
}

/**
 * Sanitize an untrusted remote reply before it reaches Slack: strip control
 * characters (keep newlines and tabs), defang Slack broadcast/command sequences
 * so a hostile agent can't @-notify a whole channel, and cap the length so it
 * can't flood or break Slack. Exported for the push-notification callback, which
 * is the trust boundary where a remote's pushed reply first enters the gateway.
 */
export function sanitizeRemoteReply(text: string): string {
  // Strip C0 control chars except \t, \n, \r.
  const stripped = text.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,
    ""
  );
  const safe = stripped.replace(/<!([^>\n]*)>/g, "@$1");
  return safe.length > MAX_REMOTE_REPLY_CHARS
    ? `${safe.slice(0, MAX_REMOTE_REPLY_CHARS)}…`
    : safe;
}

/** Shared A2A client construction: overrides the JSON-RPC transport `fetchImpl`. */
async function buildClient(
  target: A2ALocalTarget | A2ARemoteTarget
): Promise<Client> {
  const fetchImpl =
    target.kind === "local"
      ? target.fetchImpl
      : remoteFetchImpl(target.authToken);
  const options = ClientFactoryOptions.createFrom(
    ClientFactoryOptions.default,
    {
      transports: [new JsonRpcTransportFactory({ fetchImpl })]
    }
  );
  const factory = new ClientFactory(options);
  return target.kind === "local"
    ? factory.createFromAgentCard(target.card)
    : factory.createFromUrl(target.endpoint);
}

/**
 * Send one A2A message to a **local** (in-process) agent and return its reply
 * text. Local agents are our own code (trusted) and reply synchronously, so the
 * text is returned directly with no sanitization.
 */
export async function sendA2ALocal(
  target: A2ALocalTarget,
  message: Message
): Promise<string> {
  const client = await buildClient(target);
  const result = await client.sendMessage({ message });
  return extractText(result);
}

/** Result of accepting a message onto a remote agent's async task queue. */
export interface RemoteAccept {
  /** Remote-assigned Task id, or null if the remote didn't return a Task. */
  taskId: string | null;
}

/**
 * Send one A2A message to a **remote** agent for asynchronous processing. The
 * gateway supplies a `pushNotificationConfig` (webhook URL + validation token);
 * the remote MUST return immediately with a `submitted`/`working` Task and later
 * POST the terminal Task back to the webhook. We only wait for — and return — the
 * accept, never the generation. A remote that replies with a `Message` instead of
 * a Task is honoring neither the async contract nor the push config; we log and
 * treat it as accepted-without-task (its reply is dropped) rather than retrying,
 * since retrying a stateful remote would only duplicate the turn.
 */
export async function acceptA2ARemote(
  target: A2ARemoteTarget,
  message: Message,
  pushNotificationConfig: PushNotificationConfig
): Promise<RemoteAccept> {
  const client = await buildClient(target);
  const params: MessageSendParams = {
    message,
    configuration: { pushNotificationConfig }
  };
  const result = await client.sendMessage(params);
  if (result.kind === "task") return { taskId: result.id };
  console.error(
    "[a2a] remote agent returned a Message, not a Task — push-notification " +
      "contract not honored; reply (if any) dropped",
    { contextId: message.contextId }
  );
  return { taskId: null };
}
