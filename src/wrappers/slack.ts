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
  team_id?: string;
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
  teamId?: string;
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
    deleted: m.deleted === true,
    teamId: m.team_id
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

/** Resolve a channel id by exact name (public or private). null if not found. */
export async function findChannelIdByName(
  env: SlackEnv,
  name: string
): Promise<string | null> {
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
    const match = (res.channels ?? []).find((c) => c.name === name);
    if (match) return match.id;
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return null;
}

/** The bot's own Slack user id, used to skip the bot in membership handling. */
// Cached per bot token: auth.test is called once per isolate lifetime (the bot
// user id never changes while the token is in use).
const botUserIdCache = new Map<string, string | null>();

export async function getBotUserId(env: SlackEnv): Promise<string | null> {
  const cached = botUserIdCache.get(env.SLACK_BOT_TOKEN);
  if (cached !== undefined) return cached;
  const res = await callSlackApi<AuthTestResponse>(
    "auth.test",
    {},
    { token: env.SLACK_BOT_TOKEN }
  );
  assertSlackOk("auth.test", res);
  const id = res.user_id ?? null;
  botUserIdCache.set(env.SLACK_BOT_TOKEN, id);
  return id;
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
