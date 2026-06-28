import { callSlackApi, assertSlackOk } from "@chat-adapter/slack/api";
import type { SlackApiResponse } from "@chat-adapter/slack/api";
import { pickDisplayName } from "@/util/display-name";
import { slackifyMarkdown } from "slackify-markdown";

// Thin, cursor-paginated wrappers over the Slack reads the chat SDK doesn't
// cover. `callSlackApi` only throws on HTTP errors, so we assertSlackOk to
// surface Slack-level failures (e.g. missing_scope) as thrown errors.

type SlackEnv = Pick<Env, "SLACK_BOT_TOKEN">;

interface SlackMember {
  id: string;
  name?: string;
  deleted?: boolean;
  is_admin?: boolean;
  is_owner?: boolean;
  is_primary_owner?: boolean;
  profile?: { real_name?: string; display_name?: string };
}
interface UsersListResponse extends SlackApiResponse {
  members?: SlackMember[];
}
interface ConversationsMembersResponse extends SlackApiResponse {
  members?: string[];
}
interface ConversationsListResponse extends SlackApiResponse {
  channels?: { id: string; name?: string }[];
}
interface AuthTestResponse extends SlackApiResponse {
  user_id?: string;
  team_id?: string;
}
interface ChatPostMessageResponse extends SlackApiResponse {
  ts?: string;
}

/** A Slack user normalized to the fields the registry cares about. */
export interface SlackUserInfo {
  id: string;
  displayName: string | null;
  isPrimaryOwner: boolean;
  deleted: boolean;
}

function normalizeMember(m: SlackMember): SlackUserInfo {
  const display = pickDisplayName(
    m.profile?.display_name,
    m.profile?.real_name,
    m.name
  );
  return {
    id: m.id,
    displayName: display,
    isPrimaryOwner: m.is_primary_owner === true,
    deleted: m.deleted === true
  };
}

/** Iterate every Slack user via paginated `users.list`. */
export async function* iterateSlackUsers(
  env: SlackEnv
): AsyncGenerator<SlackUserInfo> {
  let cursor: string | undefined;
  do {
    const res = await callSlackApi<UsersListResponse>(
      "users.list",
      { limit: 200, ...(cursor ? { cursor } : {}) },
      { token: env.SLACK_BOT_TOKEN }
    );
    assertSlackOk("users.list", res);
    for (const m of res.members ?? []) yield normalizeMember(m);
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

/** All member ids of a channel via paginated `conversations.members`. */
export async function fetchChannelMemberIds(
  env: SlackEnv,
  channelId: string
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const res = await callSlackApi<ConversationsMembersResponse>(
      "conversations.members",
      { channel: channelId, limit: 200, ...(cursor ? { cursor } : {}) },
      { token: env.SLACK_BOT_TOKEN }
    );
    assertSlackOk("conversations.members", res);
    for (const id of res.members ?? []) ids.add(id);
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return ids;
}

/**
 * Iterate every named channel (public/private, unarchived) via paginated
 * `conversations.list`. Channels without a name (shouldn't happen for these
 * types) are skipped. Reconcile upserts these into D1 so the message hot path
 * resolves channel names without a Slack call.
 */
export async function* iterateSlackChannels(
  env: SlackEnv
): AsyncGenerator<{ id: string; name: string }> {
  let cursor: string | undefined;
  do {
    const res = await callSlackApi<ConversationsListResponse>(
      "conversations.list",
      {
        limit: 200,
        exclude_archived: true,
        types: "public_channel,private_channel",
        ...(cursor ? { cursor } : {})
      },
      { token: env.SLACK_BOT_TOKEN }
    );
    assertSlackOk("conversations.list", res);
    for (const c of res.channels ?? []) {
      if (c.name) yield { id: c.id, name: c.name };
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

/** The bot's own Slack user id and team id from `auth.test`. */
export interface BotInfo {
  userId: string | null;
  teamId: string | null;
}

// Cached per bot token: auth.test is called once per isolate lifetime (the bot
// identity never changes while the token is in use).
const botInfoCache = new Map<string, BotInfo>();

/**
 * Reset the bot-info cache. Exposed only for testing — production code never
 * calls this; cache invalidation happens naturally on isolate restart.
 * @internal
 */
export function _resetBotInfoCacheForTest(): void {
  botInfoCache.clear();
}

/** Fetch (and cache) the bot's `user_id` and `team_id` via `auth.test`. */
export async function getBotInfo(env: SlackEnv): Promise<BotInfo> {
  const cached = botInfoCache.get(env.SLACK_BOT_TOKEN);
  if (cached !== undefined) return cached;
  const res = await callSlackApi<AuthTestResponse>(
    "auth.test",
    {},
    { token: env.SLACK_BOT_TOKEN }
  );
  assertSlackOk("auth.test", res);
  const info: BotInfo = {
    userId: res.user_id ?? null,
    teamId: res.team_id ?? null
  };
  botInfoCache.set(env.SLACK_BOT_TOKEN, info);
  return info;
}

/** The bot's own Slack user id, used to skip the bot in membership handling. */
export async function getBotUserId(env: SlackEnv): Promise<string | null> {
  return (await getBotInfo(env)).userId;
}

/**
 * Post a bot reply via `chat.postMessage`. Pass `threadTs` to reply inside a
 * thread; pass null to post at the top level (e.g. in a DM). The gateway owns
 * the bot token, so all agent replies flow through here.
 */
export async function postReply(
  env: SlackEnv,
  channelId: string,
  threadTs: string | null,
  text: string
): Promise<void> {
  let mrkdwn: string;
  try {
    mrkdwn = slackifyMarkdown(text).trim();
  } catch {
    mrkdwn = text;
  }

  try {
    const res = await callSlackApi<ChatPostMessageResponse>(
      "chat.postMessage",
      {
        channel: channelId,
        text: mrkdwn,
        ...(threadTs ? { thread_ts: threadTs } : {})
      },
      { token: env.SLACK_BOT_TOKEN }
    );
    assertSlackOk("chat.postMessage", res);
    console.log("[slack] reply posted ok", { channelId, ts: res.ts });
  } catch (err) {
    console.error("[slack] postReply failed", {
      channelId,
      threadTs,
      err: String(err)
    });
    throw err;
  }
}

// Benign reaction errors that mean the desired end-state already holds, so we
// treat them as success to keep the reaction steps idempotent under retries.
const BENIGN_ADD_REACTION_ERRORS = new Set(["already_reacted"]);
const BENIGN_REMOVE_REACTION_ERRORS = new Set([
  "no_reaction",
  "message_not_found"
]);

/**
 * Add an emoji reaction to a message via `reactions.add`. Idempotent: an
 * `already_reacted` error is treated as success so step retries don't throw.
 * Requires the `reactions:write` scope on the bot token.
 */
export async function addReaction(
  env: SlackEnv,
  channelId: string,
  timestamp: string,
  name: string
): Promise<void> {
  const res = await callSlackApi<SlackApiResponse>(
    "reactions.add",
    { channel: channelId, timestamp, name },
    { token: env.SLACK_BOT_TOKEN }
  );
  if (!res.ok && BENIGN_ADD_REACTION_ERRORS.has(res.error ?? "")) return;
  assertSlackOk("reactions.add", res);
}

/**
 * Remove an emoji reaction from a message via `reactions.remove`. Idempotent: a
 * `no_reaction`/`message_not_found` error is treated as success so the backstop
 * cleanup never throws when the reaction was already collected or the message is
 * gone. Requires the `reactions:write` scope on the bot token.
 */
export async function removeReaction(
  env: SlackEnv,
  channelId: string,
  timestamp: string,
  name: string
): Promise<void> {
  const res = await callSlackApi<SlackApiResponse>(
    "reactions.remove",
    { channel: channelId, timestamp, name },
    { token: env.SLACK_BOT_TOKEN }
  );
  if (!res.ok && BENIGN_REMOVE_REACTION_ERRORS.has(res.error ?? "")) return;
  assertSlackOk("reactions.remove", res);
}
