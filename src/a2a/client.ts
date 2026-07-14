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

/**
 * Where to send an A2A message:
 * - `local`  — a known card + a `fetchImpl` bound to a Durable Object `stub.fetch`,
 *   so card discovery is skipped and the call runs in-process (no network hop).
 *   Local agents return a Task acceptance and deliver replies through a trusted
 *   in-process push sender.
 * - `remote` — a base URL; the card is discovered over real HTTP, every request
 *   carries the gateway identity JWT (`authToken`). Remote agents reply
 *   *asynchronously* via push notification — {@link sendA2ARemote} only waits
 *   for the accept (a Task ack), never for generation.
 */
export interface A2ALocalTarget {
  card: AgentCard;
  fetchImpl: typeof fetch;
}
export interface A2ARemoteTarget {
  endpoint: string;
  authToken?: string;
}

/**
 * Abort a remote *accept* that hangs. This only covers the initial handshake
 * (the remote must return a `submitted`/`working` Task immediately, A2A §7.2), not
 * generation — so it can be short. The reply itself arrives later via the
 * push-notification callback, so no gateway request ever blocks on the model.
 */
const ACCEPT_TIMEOUT_MS = 30_000;

/** Hard cap on an agent reply before it reaches Slack (untrusted output). */
const MAX_REPLY_CHARS = 16_000;

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
 * Sanitize an agent reply before it reaches Slack: strip control characters
 * (keep newlines and tabs), defang Slack broadcast/command sequences so a hostile
 * agent can't @-notify a whole channel, and cap the length so it can't flood or
 * break Slack. Applied at every delivery boundary — the remote push-notification
 * callback and the local in-process sender alike — because even a built-in agent
 * relays untrusted model output.
 */
export function sanitizeAgentReply(text: string): string {
  // Strip C0 control chars except \t, \n, \r.
  const stripped = text.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,
    ""
  );
  // Defang Slack broadcast/command sequences (<!channel>, <!here>, <!everyone>,
  // <!subteam^…>) so a hostile reply can't @-notify a whole channel — even if a
  // downstream conversion error makes postReply post the raw text. slackifyMarkdown
  // escapes these on the normal path; this is the belt-and-suspenders at the trust
  // boundary. Legitimate mentions (<@U…>, <#C…>) are intentionally left intact.
  const safe = stripped.replace(/<!([^>\n]*)>/g, "@$1");
  return safe.length > MAX_REPLY_CHARS
    ? `${safe.slice(0, MAX_REPLY_CHARS)}…`
    : safe;
}

/** Build a local A2A client using an in-process Durable Object fetch impl. */
async function buildLocalClient(target: A2ALocalTarget): Promise<Client> {
  const options = ClientFactoryOptions.createFrom(
    ClientFactoryOptions.default,
    {
      transports: [new JsonRpcTransportFactory({ fetchImpl: target.fetchImpl })]
    }
  );
  const factory = new ClientFactory(options);
  return factory.createFromAgentCard(target.card);
}

/** Build a remote A2A client with auth header injection and accept timeout. */
async function buildRemoteClient(target: A2ARemoteTarget): Promise<Client> {
  const options = ClientFactoryOptions.createFrom(
    ClientFactoryOptions.default,
    {
      transports: [
        new JsonRpcTransportFactory({
          fetchImpl: remoteFetchImpl(target.authToken)
        })
      ]
    }
  );
  const factory = new ClientFactory(options);
  return factory.createFromUrl(target.endpoint);
}

/**
 * Send one A2A message to a **local** (in-process) agent. The SDK's `sendMessage`
 * is blocking by default, so this awaits the agent's whole turn (generation rides
 * the in-flight DO request, immune to eviction) and the value returned here is the
 * *final* Task, not just an acceptance. The agent's Task snapshots are handed to
 * the local push sender, which the SDK fires without awaiting — so the Slack
 * delivery is kicked off during this call and completes shortly after; the agent
 * DO registers it on `ctx.waitUntil`, so the runtime won't drop it. The caller
 * only forwards the task id for correlation and never handles model text directly.
 */
export async function sendA2ALocal(
  target: A2ALocalTarget,
  message: Message,
  pushNotificationConfig: PushNotificationConfig
): Promise<A2AAccept> {
  const client = await buildLocalClient(target);
  const params: MessageSendParams = {
    message,
    configuration: { pushNotificationConfig }
  };
  return acceptedTask(await client.sendMessage(params), message);
}

/** Result of accepting a message onto an A2A agent's task queue. */
export type A2AAccept =
  | {
      /** Remote accepted the turn and returned its Task id. */
      kind: "accepted";
      taskId: string;
    }
  | {
      /** Remote omitted the required async Task acceptance/id. */
      kind: "contract_violation";
    };

function acceptedTask(
  result: Awaited<ReturnType<Client["sendMessage"]>>,
  message: Message
): A2AAccept {
  if (result.kind === "task" && result.id.trim().length > 0) {
    return { kind: "accepted", taskId: result.id };
  }
  console.error(
    "[a2a] agent accept response missing required Task acceptance " +
      "(submitted/working Task with non-empty id); push-notification contract " +
      "not honored",
    { contextId: message.contextId }
  );
  return { kind: "contract_violation" };
}

/**
 * Send one A2A message to a **remote** agent for asynchronous processing. The
 * gateway supplies a `pushNotificationConfig` (webhook URL + validation token);
 * the remote MUST return immediately with a `submitted`/`working` Task and later
 * POST the terminal Task back to the webhook. We only wait for — and return — the
 * accept, never the generation. If the remote response does not contain the
 * required Task acceptance (including a non-empty Task id), we log and return a
 * contract-violation outcome for the caller to surface.
 */
export async function sendA2ARemote(
  target: A2ARemoteTarget,
  message: Message,
  pushNotificationConfig: PushNotificationConfig
): Promise<A2AAccept> {
  const client = await buildRemoteClient(target);
  const params: MessageSendParams = {
    message,
    configuration: { pushNotificationConfig }
  };
  return acceptedTask(await client.sendMessage(params), message);
}
