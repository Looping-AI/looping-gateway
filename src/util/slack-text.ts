/**
 * Channel-wide mentions, in both spellings Slack accepts:
 *
 *  - the *command sequence* `<!channel>` / `<!here>` / `<!everyone>` / `<!subteam^S…>`,
 *    which Slack always renders in a message's `text` as a broadcast @-notification;
 *  - the *plain* `@channel` / `@here` / `@everyone`, which Slack links up whenever a
 *    message is posted with `link_names`.
 *
 * Both are neutralized by dropping the marker (`<!here>` and `@here` alike become
 * `here`), which no re-parse can turn back into a ping. `slackifyMarkdown` passes
 * `<!…>` through verbatim — it treats it as raw HTML — so this module, not the
 * markdown conversion, is what stands between untrusted text and a channel-wide ping.
 */
const COMMAND_SEQUENCE = /<!([^>\n]*)>/;
const COMMAND_SEQUENCE_ALL = new RegExp(COMMAND_SEQUENCE, "g");

// `@channel` and friends. The lookbehind keeps an address (`ops@here.com`) and the
// `\b` keeps a longer word (`@channels`) out of it; `@channel-ops` does match, which
// is the conservative side to err on.
const PLAIN_BROADCAST = /(?<![\w@])@(channel|here|everyone)\b/i;
const PLAIN_BROADCAST_ALL = new RegExp(PLAIN_BROADCAST, "gi");

/** Does this string carry a channel-wide mention in either spelling? */
export function hasSlackBroadcast(text: string): boolean {
  return COMMAND_SEQUENCE.test(text) || PLAIN_BROADCAST.test(text);
}

/**
 * Make untrusted text safe to hand to Slack as message text: strip C0 control
 * characters (keeping `\t`, `\n`, `\r`) and neutralize channel-wide mentions in
 * both spellings. Mentions of a single user or channel (`<@U…>`, `<#C…>`) are
 * intentionally left intact — they notify one person or link one channel.
 */
export function sanitizeSlackText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(COMMAND_SEQUENCE_ALL, "$1")
    .replace(PLAIN_BROADCAST_ALL, "$1");
}
