import {
  ClientFactory,
  ClientFactoryOptions,
  JsonRpcTransportFactory,
  type Client
} from "@a2a-js/sdk/client";
import { A2A_ERROR_CODE } from "@a2a-js/sdk/errors";
import type {
  AgentCard,
  Message,
  SendMessageRequest,
  Task,
  TaskPushNotificationConfig
} from "@a2a-js/sdk";
import { isMessageResult } from "@/a2a/parts";

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
 * Send one A2A message to a **local** (in-process) agent. The request asks to
 * return immediately, so the SDK answers as soon as the agent accepts the turn
 * rather than awaiting generation — the same accept-only shape
 * {@link sendA2ARemote} has, just in-process without the HTTP/JWT hop. Generation and the Slack delivery run
 * asynchronously inside the agent DO, which keeps itself alive until the terminal
 * delivery settles via a `ctx.waitUntil` liveness barrier. The caller only forwards
 * the task id for correlation and never handles model text directly.
 */
export async function sendA2ALocal(
  target: A2ALocalTarget,
  message: Message,
  taskPushNotificationConfig: TaskPushNotificationConfig
): Promise<A2AAccept> {
  const client = await buildLocalClient(target);
  return acceptedTask(
    await client.sendMessage(sendRequest(message, taskPushNotificationConfig)),
    message
  );
}

/**
 * Build the v1.0 `SendMessageRequest` both dispatch paths share.
 *
 * `returnImmediately: true` is v1.0's replacement for v0.3's `blocking: false`
 * (the semantics are inverted): the agent must answer as soon as it has
 * accepted the turn — the initial `submitted` Task, carrying the real
 * SDK-assigned task id — instead of holding the request open until generation
 * finishes. The reply arrives later on the push-notification callback, so no
 * gateway request ever blocks on a model.
 *
 * `tenant` is empty because a gateway agent instance *is* its own tenant: local
 * built-ins are addressed by Durable Object instance, and each remote agent has
 * its own registered endpoint.
 */
function sendRequest(
  message: Message,
  taskPushNotificationConfig: TaskPushNotificationConfig
): SendMessageRequest {
  return {
    tenant: "",
    message,
    configuration: {
      acceptedOutputModes: ["text/plain"],
      taskPushNotificationConfig,
      historyLength: undefined,
      returnImmediately: true
    },
    metadata: undefined
  };
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
  if (!isMessageResult(result) && result.id.trim().length > 0) {
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
  taskPushNotificationConfig: TaskPushNotificationConfig
): Promise<A2AAccept> {
  const client = await buildRemoteClient(target);
  return acceptedTask(
    await client.sendMessage(sendRequest(message, taskPushNotificationConfig)),
    message
  );
}

/**
 * Outcome of asking a remote agent to cancel a task (A2A `tasks/cancel`).
 * Cancellation is *attempted*, not guaranteed (A2A §7.5): the terminal outcomes
 * below all mean "stop trying" from the gateway's side.
 * - `canceled`      — the agent transitioned the task to a terminal `canceled`.
 * - `not_cancelable`— the task was already terminal (e.g. it just completed);
 *                     `TaskNotCancelableError` (-32002). Idempotent no-op.
 * - `not_found`     — the agent has no such task (-32001). Idempotent no-op.
 * - `unsupported`   — the agent doesn't implement cancellation (-32004); the task
 *                     keeps running and the gateway should say so.
 * - `error`         — transport/other failure; the caller may surface or retry.
 */
export type CancelOutcome =
  | { kind: "canceled"; task: Task }
  | { kind: "not_cancelable" }
  | { kind: "not_found" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

/**
 * Ask a **remote** agent to cancel a task via the standard A2A `tasks/cancel`
 * method. Synchronous by contract — the agent returns the updated Task
 * immediately — so the gateway self-reconciles from this response and does NOT
 * wait for a push callback (a conformant agent sends none after cancellation).
 * The SDK maps A2A error codes to typed errors, which we fold into a
 * {@link CancelOutcome} the caller can act on without touching the SDK surface.
 */
export async function cancelA2ARemote(
  target: A2ARemoteTarget,
  taskId: string
): Promise<CancelOutcome> {
  const client = await buildRemoteClient(target);
  try {
    const task = await client.cancelTask({
      tenant: "",
      id: taskId,
      metadata: undefined
    });
    return { kind: "canceled", task };
  } catch (err) {
    switch (a2aErrorCode(err)) {
      case A2A_ERROR_CODE.TASK_NOT_CANCELABLE:
        return { kind: "not_cancelable" };
      case A2A_ERROR_CODE.TASK_NOT_FOUND:
        return { kind: "not_found" };
      case A2A_ERROR_CODE.UNSUPPORTED_OPERATION:
        return { kind: "unsupported" };
      default:
        return {
          kind: "error",
          message: err instanceof Error ? err.message : String(err)
        };
    }
  }
}

/**
 * The A2A JSON-RPC error code carried by an error the SDK client threw.
 *
 * Deliberately reads the wire code instead of testing `instanceof` against the
 * semantic error classes (`TaskNotFoundError` & co.): `@a2a-js/sdk/client` and
 * `@a2a-js/sdk/errors` are separately bundled entry points that each carry
 * their own copy of the error hierarchy, so the class the client throws is a
 * *different class object* from the one importable here and `instanceof` is
 * always false — every typed outcome would silently degrade to a generic
 * error. The codes are spec-defined (A2A §5.4) and identical across both
 * copies, so they are the stable thing to classify on.
 */
function a2aErrorCode(err: unknown): number | undefined {
  const code = (err as { envelopeCode?: unknown } | null)?.envelopeCode;
  return typeof code === "number" ? code : undefined;
}
