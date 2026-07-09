import type { Message, Part, Task, TaskState } from "@a2a-js/sdk";

/**
 * Terminal A2A task states — those after which no further push notifications
 * arrive. `submitted` / `working` / `input-required` / `auth-required` /
 * `unknown` are non-terminal (the task is still in flight).
 */
const TERMINAL_STATES = new Set<TaskState>([
  "completed",
  "failed",
  "canceled",
  "rejected"
]);

/** Whether a task state is terminal (no further updates expected). */
export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

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
 * Extract a single reply string from an A2A send result from remote agents.
 * Message-shaped responses return text from message parts; task-shaped
 * responses return the first available text from the status message or
 * artifacts. Returns "" if nothing textual was produced.
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
