import {
  verifySlackRequest,
  parseSlackWebhookBody,
  SlackWebhookVerificationError
} from "@chat-adapter/slack/webhook";
import type { SlackWebhookPayload } from "@chat-adapter/slack/webhook";
import { isRecord, str } from "@/util/json";
import { pickDisplayName } from "@/util/display-name";
import type {
  MessageWorkflowParams,
  LifecycleWorkflowParams,
  Classification
} from "@/slack/types";
export type { MessageWorkflowParams, LifecycleWorkflowParams, Classification };

const LIFECYCLE_EVENT_TYPES = new Set([
  "member_joined_channel",
  "member_left_channel",
  "team_join"
]);

const MESSAGE_EDIT_SUBTYPES = new Set(["message_changed", "message_deleted"]);

function userIdOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value)) return str(value.id);
  return undefined;
}

/**
 * Map a parsed Slack webhook payload to the Workflow it should drive.
 *
 * Exported for unit-testing in isolation. The gateway calls this via
 * handleSlackEvent — not directly.
 *
 * Note: parseSlackWebhookBody only types app_mention, direct_message,
 * slash/interactive, and url_verification. Lifecycle events arrive as
 * kind:"unsupported" with the event type on payload.type and the full
 * envelope on payload.raw, so we classify those from raw.
 */
export function classifyEvent(payload: SlackWebhookPayload): Classification {
  switch (payload.kind) {
    case "url_verification":
      return { kind: "challenge", challenge: payload.challenge };

    case "app_mention":
      return {
        kind: "message",
        params: {
          eventId: payload.eventId ?? crypto.randomUUID(),
          eventType: "app_mention",
          channelId: payload.channelId,
          threadTs: payload.threadTs,
          ts: payload.ts,
          userId: payload.userId,
          teamId: payload.teamId,
          text: payload.text,
          raw: payload.raw
        }
      };

    case "direct_message": {
      if (payload.subtype && MESSAGE_EDIT_SUBTYPES.has(payload.subtype)) {
        return {
          kind: "lifecycle",
          params: {
            eventId: payload.eventId ?? crypto.randomUUID(),
            type: "message",
            subtype: payload.subtype,
            channelId: payload.channelId,
            userId: payload.userId,
            teamId: payload.teamId,
            raw: payload.raw
          }
        };
      }
      if (payload.botId || payload.subtype === "bot_message") {
        return { kind: "ignore", reason: "bot message" };
      }
      return {
        kind: "message",
        params: {
          eventId: payload.eventId ?? crypto.randomUUID(),
          eventType: "message",
          channelId: payload.channelId,
          threadTs: payload.threadTs,
          ts: payload.ts,
          userId: payload.userId,
          teamId: payload.teamId,
          text: payload.text,
          raw: payload.raw
        }
      };
    }

    case "unsupported": {
      const eventType = payload.type;
      const envelope = isRecord(payload.raw) ? payload.raw : undefined;
      const event =
        envelope && isRecord(envelope.event) ? envelope.event : undefined;
      const subtype = event ? str(event.subtype) : undefined;

      const isLifecycle =
        LIFECYCLE_EVENT_TYPES.has(eventType) ||
        (eventType === "message" &&
          !!subtype &&
          MESSAGE_EDIT_SUBTYPES.has(subtype));

      if (isLifecycle) {
        // For team_join, the user field is an object — extract the display name
        // here so the Workflow handler receives it directly on params.displayName
        // rather than re-digging the raw envelope.
        let displayName: string | null = null;
        if (eventType === "team_join") {
          const user = event && isRecord(event.user) ? event.user : undefined;
          const profile =
            user && isRecord(user.profile) ? user.profile : undefined;
          displayName = pickDisplayName(
            str(profile?.display_name),
            str(profile?.real_name),
            str(user?.name)
          );
        }

        return {
          kind: "lifecycle",
          params: {
            eventId: str(envelope?.event_id) ?? crypto.randomUUID(),
            type: eventType,
            subtype,
            channelId: event ? str(event.channel) : undefined,
            userId: event ? userIdOf(event.user) : undefined,
            teamId: envelope ? str(envelope.team_id) : undefined,
            displayName,
            raw: envelope ?? {}
          }
        };
      }

      return { kind: "ignore", reason: `unsupported event: ${eventType}` };
    }

    // slash_command, block_actions, block_suggestion, view_submission, view_closed
    default:
      return { kind: "ignore", reason: `interactive: ${payload.kind}` };
  }
}

// ---------------------------------------------------------------------------
// Workflow dispatch
// ---------------------------------------------------------------------------

const OK = () => new Response("ok", { status: 200 });

// Matches the error Cloudflare Workflows throws when create() is called with a
// duplicate instance id (Slack retry delivering the same event_id). The message
// always contains "already exists"; the broader "duplicate" arm was a guess and
// has been dropped to avoid false positives on unrelated errors.
function isInstanceExistsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(message);
}

async function triggerWorkflow(
  workflow: Workflow,
  params: MessageWorkflowParams | LifecycleWorkflowParams
): Promise<Response> {
  const id = params.eventId;
  try {
    await workflow.create({ id, params });
  } catch (err) {
    if (isInstanceExistsError(err)) {
      console.log("[gateway] duplicate event — skipping", { eventId: id });
      return OK();
    }
    console.error("[gateway] failed to create workflow instance", {
      eventId: id,
      err: String(err)
    });
    return new Response("error", { status: 500 });
  }
  return OK();
}

// ---------------------------------------------------------------------------
// Entry point — called by the gateway fetch handler
// ---------------------------------------------------------------------------

/**
 * Verify the Slack signature, classify the event, trigger the matching
 * Workflow, and return 200 before any agent work runs.
 *
 * Returns 401 on bad signature, 500 on unexpected Workflow failure (so Slack
 * retries), and 200 for everything else — including ignored events and
 * duplicate event_ids (Slack retries get native dedupe via the instance id).
 */
export async function handleSlackEvent(
  request: Request,
  env: Pick<
    Env,
    "SLACK_SIGNING_SECRET" | "MESSAGE_WORKFLOW" | "LIFECYCLE_WORKFLOW"
  >
): Promise<Response> {
  let rawBody: string;
  try {
    rawBody = await verifySlackRequest(request, {
      signingSecret: env.SLACK_SIGNING_SECRET
    });
  } catch (err) {
    if (err instanceof SlackWebhookVerificationError) {
      return new Response("Invalid signature", { status: 401 });
    }
    throw err;
  }

  const payload = parseSlackWebhookBody(rawBody, { headers: request.headers });
  const classification = classifyEvent(payload);

  switch (classification.kind) {
    case "challenge":
      console.log("[gateway] url_verification challenge");
      return Response.json({ challenge: classification.challenge });
    case "message":
      return triggerWorkflow(env.MESSAGE_WORKFLOW, classification.params);
    case "lifecycle":
      return triggerWorkflow(env.LIFECYCLE_WORKFLOW, classification.params);
    case "ignore":
      console.log("[gateway] event ignored", { reason: classification.reason });
      return OK();
  }
}
