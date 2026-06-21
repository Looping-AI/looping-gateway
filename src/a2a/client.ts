import {
  ClientFactory,
  ClientFactoryOptions,
  JsonRpcTransportFactory
} from "@a2a-js/sdk/client";
import type { AgentCard, Message, MessageSendParams } from "@a2a-js/sdk";
import { extractText } from "./parts";

/**
 * Where to send an A2A message:
 * - `local`  — a known card + a `fetchImpl` bound to a Durable Object `stub.fetch`,
 *   so card discovery is skipped and the call runs in-process (no network hop).
 * - `remote` — a base URL; the card is discovered over real HTTP, every request
 *   carries the gateway identity JWT (`authToken`), and the reply is treated as
 *   untrusted (timeout + length cap + control-char strip).
 */
export type A2ATarget =
  | { kind: "local"; card: AgentCard; fetchImpl: typeof fetch }
  | { kind: "remote"; endpoint: string; authToken?: string };

/** Abort a remote agent call that hangs — it must never block the workflow step. */
const REMOTE_TIMEOUT_MS = 30_000;

/** Hard cap on a remote reply before it reaches Slack (untrusted output). */
const MAX_REMOTE_REPLY_CHARS = 16_000;

/**
 * Build a `fetchImpl` for a remote target: injects the gateway JWT as a Bearer
 * token on every request and enforces a request timeout. Reuses the same
 * `fetchImpl` override seam the local (DO stub) path uses.
 */
function remoteFetchImpl(authToken?: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (authToken) headers.set("authorization", `Bearer ${authToken}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
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
 * Sanitize an untrusted remote reply: strip control characters (keep newlines
 * and tabs) and cap the length so a hostile agent can't flood or break Slack.
 */
function sanitizeRemoteReply(text: string): string {
  const stripped = text.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,
    ""
  );
  return stripped.length > MAX_REMOTE_REPLY_CHARS
    ? `${stripped.slice(0, MAX_REMOTE_REPLY_CHARS)}…`
    : stripped;
}

/**
 * Send one A2A message and return the agent's reply text. Uses the official
 * `@a2a-js/sdk` client; the JSON-RPC transport's `fetchImpl` is overridden for
 * local targets (DO `stub.fetch`) and for remote targets (auth header + timeout).
 */
export async function sendA2AMessage(
  target: A2ATarget,
  message: Message
): Promise<string> {
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

  const client =
    target.kind === "local"
      ? await factory.createFromAgentCard(target.card)
      : await factory.createFromUrl(target.endpoint);

  const params: MessageSendParams = { message };
  const result = await client.sendMessage(params);
  const text = extractText(result);
  // Local agents are our own code (trusted); remote replies are not.
  return target.kind === "remote" ? sanitizeRemoteReply(text) : text;
}
