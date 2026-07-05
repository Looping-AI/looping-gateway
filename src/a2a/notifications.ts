import type { Task } from "@a2a-js/sdk";
import { isRecord } from "@/util/json";
import { getAgent } from "@/db/models/agents";
import {
  getAgentTaskByToken,
  completeAgentTask,
  recordAgentTaskError
} from "@/db/models/agent-tasks";
import {
  getPublicUrl,
  getAllowedRemoteAgentDomains
} from "@/db/models/workspace-configs";
import {
  verifyAgentCallbackToken,
  AgentCallbackAuthError
} from "@/auth/agent-inbound";
import { extractText } from "@/a2a/parts";
import { sanitizeRemoteReply } from "@/a2a/client";
import { postReply } from "@/wrappers/slack";
import { signalReactionCollect } from "@/workflows/message";

/** Header carrying the per-task validation token the gateway set in pushNotificationConfig. */
export const NOTIFICATION_TOKEN_HEADER = "x-a2a-notification-token";

/** The gateway path remote agents POST terminal Tasks to (also the JWT `aud`). */
export const NOTIFICATIONS_PATH = "/a2a/notifications";

const OK = () => new Response("ok", { status: 200 });

/**
 * Persist why a callback was rejected onto the pending task row so the reaction
 * backstop can surface the reason to the Slack user. Best-effort: a DB failure
 * must never change the HTTP status we return to the remote. `message` is always
 * a gateway-controlled string (never remote payload) so it is safe to store and
 * later post verbatim.
 */
async function captureCallbackError(
  token: string,
  message: string
): Promise<void> {
  try {
    await recordAgentTaskError(token, message);
  } catch (err) {
    console.error("[notifications] failed to record callback error", {
      err: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Handle a remote agent's push-notification callback (A2A spec §13.2). This is
 * how a remote agent's reply actually reaches Slack now: the gateway accepted the
 * turn earlier and handed the remote a webhook URL + validation `token`; the
 * remote generates on its own time and POSTs the terminal Task here.
 *
 * Trust boundary. Everything here is untrusted until proven:
 *  1. The `token` header must match a pending `agent_tasks` row (correlation).
 *  2. The `Authorization: Bearer` JWT must verify against that agent's *pinned*
 *     card signing key, with `aud` = this endpoint and a fresh `iat`/`exp`.
 * Only then do we read the pushed Task, post its (sanitized) text under the
 * agent's identity, and collect the ⏳. Single-use is enforced by flipping the
 * row to `completed` after a successful post, so retries/replays are no-ops.
 */
export async function handleAgentNotification(
  request: Request
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const notificationToken = request.headers.get(NOTIFICATION_TOKEN_HEADER);
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!notificationToken || !bearer) {
    return new Response("missing credentials", { status: 401 });
  }

  const row = await getAgentTaskByToken(notificationToken);
  if (!row) {
    // Unknown token — either never issued or already swept. Deny.
    return new Response("unknown task", { status: 404 });
  }
  if (row.status === "completed") return OK(); // already handled — idempotent

  const agent = await getAgent(row.agentName);
  if (!agent || !agent.cardSigningJku || !agent.cardSigningKid) {
    console.error("[notifications] agent missing or unsigned", {
      agent: row.agentName
    });
    await captureCallbackError(
      notificationToken,
      "the agent's registration is missing its card signing key, so its callback could not be verified"
    );
    return new Response("agent not verifiable", { status: 401 });
  }

  // Expected audience = exactly the webhook URL we set in the pushNotificationConfig
  // at dispatch (issuer + path), not a proxy-mangled request.url.
  const issuer = await getPublicUrl();
  const audience = `${issuer ?? new URL(request.url).origin}${NOTIFICATIONS_PATH}`;
  const allowedDomains = await getAllowedRemoteAgentDomains();

  try {
    await verifyAgentCallbackToken({
      token: bearer,
      pin: {
        cardSigningJku: agent.cardSigningJku,
        cardSigningKid: agent.cardSigningKid
      },
      audience,
      allowedDomains
    });
  } catch (err) {
    if (err instanceof AgentCallbackAuthError) {
      console.warn("[notifications] callback auth rejected", {
        agent: row.agentName,
        err: err.message
      });
      await captureCallbackError(
        notificationToken,
        `the callback signature could not be verified (${err.message})`
      );
      return new Response("invalid callback token", { status: 401 });
    }
    throw err;
  }

  // Authenticated. Read the pushed Task and post its reply (if any).
  let task: Task | null = null;
  try {
    const body = await request.json();
    if (isRecord(body) && body.kind === "task") task = body as unknown as Task;
  } catch {
    task = null;
  }
  if (!task) {
    await captureCallbackError(
      notificationToken,
      "the callback body was not a valid A2A Task"
    );
    return new Response("expected a Task body", { status: 400 });
  }

  const text = sanitizeRemoteReply(extractText(task));
  const displayName = agent.displayName ?? agent.name;
  const iconUrl = agent.iconUrl ?? null;

  // Post BEFORE marking complete so a postMessage failure leaves the row pending
  // for the remote to retry (a retry after success sees `completed` → no-op). An
  // empty reply means the agent classified the turn as needing no response: post
  // nothing, but still complete + collect the ⏳.
  if (text) {
    await postReply(
      row.channelId,
      row.replyThreadTs,
      text,
      displayName,
      iconUrl
    );
  }

  await completeAgentTask(notificationToken);
  await signalReactionCollect(row.eventId);
  return OK();
}
