import type { Message, Part, Task } from "@a2a-js/sdk";

/** Concatenate the text of every `TextPart`, trimming surrounding whitespace. */
function partsText(parts: Part[] | undefined): string {
  if (!parts) return "";
  return parts
    .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text)
    .join("")
    .trim();
}

/** The plain-text content of an inbound A2A message (what the user said). */
export function textOf(message: Message): string {
  return partsText(message.parts);
}

/**
 * Extract a single reply string from an A2A send result. Echo agents return a
 * `Message`; task-shaped agents (later) surface text via the status message or
 * the first artifact. Returns "" if nothing textual was produced.
 */
export function extractText(result: Message | Task): string {
  if (result.kind === "message") return partsText(result.parts);

  const statusText = partsText(
    result.status?.message?.parts as Part[] | undefined
  );
  if (statusText) return statusText;

  for (const artifact of result.artifacts ?? []) {
    const text = partsText(artifact.parts as Part[] | undefined);
    if (text) return text;
  }
  return "";
}
