/**
 * Slack command sequences — `<!channel>`, `<!here>`, `<!everyone>`,
 * `<!subteam^S…>`. Slack renders these in a message's `text` as broadcast
 * @-notifications, so any untrusted string that reaches `text` must have them
 * defanged first. `slackifyMarkdown` passes them through verbatim (it treats
 * `<!…>` as raw HTML), so this module — not the markdown conversion — is what
 * stands between untrusted text and a channel-wide ping.
 */
const COMMAND_SEQUENCE = /<!([^>\n]*)>/;
const COMMAND_SEQUENCE_ALL = new RegExp(COMMAND_SEQUENCE, "g");

/** Does this string carry a Slack command sequence (`<!channel>`, `<!here>`, …)? */
export function hasSlackCommandSequence(text: string): boolean {
  return COMMAND_SEQUENCE.test(text);
}

/**
 * Make untrusted text safe to hand to Slack as message text: strip C0 control
 * characters (keeping `\t`, `\n`, `\r`) and defang command sequences into their
 * inert `@…` form. Legitimate mentions (`<@U…>`, `<#C…>`) are intentionally left
 * intact — they notify one user or link one channel, not everyone.
 */
export function sanitizeSlackText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(COMMAND_SEQUENCE_ALL, "@$1");
}
