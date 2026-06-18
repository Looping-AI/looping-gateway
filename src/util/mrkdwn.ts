/**
 * Convert standard Markdown produced by the AI to Slack's mrkdwn format.
 * Code spans/blocks are preserved verbatim.
 */
export function markdownToMrkdwn(text: string): string {
  const saved: string[] = [];
  const save = (s: string) => {
    saved.push(s);
    return `\x00${saved.length - 1}\x00`;
  };

  // Protect code blocks and inline code from transformation
  text = text.replace(/```[\s\S]*?```/g, save).replace(/`[^`\n]+`/g, save);

  text = text
    // Headings → bold (# Foo → *Foo*)
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    // Bold: **text** → *text*
    .replace(/\*\*(.+?)\*\*/gs, "*$1*")
    // Bold: __text__ → *text*
    .replace(/__(.+?)__/gs, "*$1*")
    // Strikethrough: ~~text~~ → ~text~
    .replace(/~~(.+?)~~/gs, "~$1~")
    // Links: [text](url) → <url|text>
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Restore protected spans
  return text.replace(/\x00(\d+)\x00/g, (_, i) => saved[+i]);
}
