import { getChannelName } from "@/wrappers/slack";

const CACHE_PREFIX = "chan:";
// Channel renames are rare; a day of staleness is an acceptable trade for not
// calling conversations.info on every turn.
const TTL_SECONDS = 86_400;
// Distinguishes a cached "looked up, has no name" (DMs / group DMs) from a miss.
const NO_NAME = "";

type ChannelCacheEnv = Pick<Env, "GATEWAY_CACHE" | "SLACK_BOT_TOKEN">;

/**
 * Resolve a Slack channel id to its human name (`general`, no `#`), cached in KV
 * with a TTL. A hit — including the empty-string sentinel cached for DMs — skips
 * Slack entirely. On any Slack error we log and return null so a turn is never
 * blocked on channel resolution.
 */
export async function resolveChannelName(
  env: ChannelCacheEnv,
  channelId: string
): Promise<string | null> {
  const key = CACHE_PREFIX + channelId;
  const cached = await env.GATEWAY_CACHE.get(key);
  if (cached !== null) return cached === NO_NAME ? null : cached;

  let name: string | null;
  try {
    name = await getChannelName(env, channelId);
  } catch (err) {
    console.warn("[channel-cache] name lookup failed", {
      channelId,
      err: String(err)
    });
    return null;
  }

  await env.GATEWAY_CACHE.put(key, name ?? NO_NAME, {
    expirationTtl: TTL_SECONDS
  });
  return name;
}
