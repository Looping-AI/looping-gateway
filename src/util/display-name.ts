import { sanitizeSlackText } from "@/util/slack-text";

/**
 * Make a display name safe to render in Slack. A display name is untrusted from
 * every direction: the admin agent's model names itself with
 * `self_set_display_name`, names custom agents with `agents_create`/`agents_update`,
 * and an un-overridden custom agent inherits the name published on the remote's own
 * A2A card. It is not only `chat.postMessage`'s `username` (which Slack does not
 * parse) — it is also interpolated into message *text* on the agent-failure notice,
 * where a `<!channel>`/`@channel` name would fire a channel-wide ping. So it goes
 * through the same sanitizer as reply text, with whitespace collapsed to keep it
 * one line.
 *
 * Applied by **every writer** of a display name (`registerAgent`, `updateAgent`,
 * `setAdminDisplayName`), so an unsafe name cannot exist in the database and read
 * paths need no guard of their own. Returns "" when nothing renderable survives;
 * writers store null and rendering falls back to the agent's machine name.
 */
export function sanitizeDisplayName(name: string): string {
  return sanitizeSlackText(name).replace(/\s+/g, " ").trim();
}

/**
 * Pick the best available display name from Slack user fields.
 * Prefers display_name → real_name → name. Returns null if all are blank.
 */
export function pickDisplayName(
  displayName?: string | null,
  realName?: string | null,
  name?: string | null
): string | null {
  return displayName?.trim() || realName?.trim() || name?.trim() || null;
}
