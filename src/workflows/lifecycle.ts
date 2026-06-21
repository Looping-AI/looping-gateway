import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { LifecycleWorkflowParams } from "@/slack/types";
import type { Db } from "@/db/client";
import { getDb } from "@/db/client";
import { upsertSlackUser } from "@/db/models/users";
import { getWorkspaceByAdminChannel } from "@/db/models/workspaces";
import {
  addWorkspaceAdmin,
  removeWorkspaceAdmin
} from "@/db/models/workspace-admins";
import { getBotUserId } from "@/wrappers/slack";

// ---------------------------------------------------------------------------
// Pure per-event handlers — exported for unit testing (mirrors classifyEvent).
// Every write is idempotent: Workflow steps retry and Slack redelivers events.
// ---------------------------------------------------------------------------

/** team_join → register the new user (flags stay default; reconcile owns them). */
export async function handleTeamJoin(
  db: Db,
  params: LifecycleWorkflowParams
): Promise<void> {
  if (!params.userId) return;
  await upsertSlackUser(db, {
    slackUserId: params.userId,
    displayName: params.displayName ?? null
  });
}

/** Joining a workspace's admin channel ⇒ admin of that workspace. */
export async function handleMemberJoined(
  db: Db,
  params: LifecycleWorkflowParams,
  botUserId: string | null
): Promise<void> {
  if (!params.channelId || !params.userId) return;
  if (botUserId && params.userId === botUserId) return; // bot's own join
  const ws = await getWorkspaceByAdminChannel(db, params.channelId);
  if (!ws) return; // not an admin channel — no-op (allowlist is Phase 4)
  await addWorkspaceAdmin(db, ws.id, params.userId, "membership");
}

/** Leaving a workspace's admin channel ⇒ losing that workspace's admin rights. */
export async function handleMemberLeft(
  db: Db,
  params: LifecycleWorkflowParams,
  botUserId: string | null
): Promise<void> {
  if (!params.channelId || !params.userId) return;
  if (botUserId && params.userId === botUserId) return;
  const ws = await getWorkspaceByAdminChannel(db, params.channelId);
  if (!ws) return;
  await removeWorkspaceAdmin(db, ws.id, params.userId);
}

// ---------------------------------------------------------------------------
// Workflow — thin dispatcher of idempotent steps over the handlers above.
// ---------------------------------------------------------------------------

/**
 * Durable, retriable handler for non-agent lifecycle events. The gateway
 * triggers one instance per Slack `event_id`. Writes the D1 registry
 * (users/workspaces/admins); reconcile (cron) is the convergence backstop.
 */
export class LifecycleWorkflow extends WorkflowEntrypoint<
  Env,
  LifecycleWorkflowParams
> {
  async run(event: WorkflowEvent<LifecycleWorkflowParams>, step: WorkflowStep) {
    const { type, subtype } = event.payload;

    switch (type) {
      case "team_join":
        await step.do("team-join", () =>
          handleTeamJoin(getDb(this.env), event.payload)
        );
        return;

      case "member_joined_channel":
        await step.do("member-joined", async () => {
          const botUserId = await getBotUserId(this.env);
          await handleMemberJoined(getDb(this.env), event.payload, botUserId);
        });
        return;

      case "member_left_channel":
        await step.do("member-left", async () => {
          const botUserId = await getBotUserId(this.env);
          await handleMemberLeft(getDb(this.env), event.payload, botUserId);
        });
        return;

      default:
        // message_changed / message_deleted edits — no registry impact yet.
        // TODO(phase-6): feed the channel-history raw buffer + Vectorize index.
        await step.do("noop-message-edit", async () => {
          console.log("LifecycleWorkflow: no-op lifecycle event", {
            instanceId: event.instanceId,
            type,
            subtype
          });
        });
        return;
    }
  }
}
