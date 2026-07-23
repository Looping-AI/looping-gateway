import { z } from "zod";
import type { Message, Part } from "@a2a-js/sdk";
import type {
  SlackInputOption,
  SlackInputRequest
} from "@chat-adapter/slack/blocks";
import { isRecord } from "@/util/json";

/**
 * The gateway's human-in-the-loop (HITL) wire contract, carried inside A2A
 * `DataPart`s. A2A does not standardize a form schema (`DataPart.data` is
 * arbitrary JSON), so we namespace our own `data.type` discriminators — this is
 * spec-compliant and lets a non-HITL-aware client still read the sibling
 * `TextPart` fallback.
 *
 * Flow:
 * - An agent that needs a human decision transitions its task to
 *   `input-required` and emits a status update whose `status.message.parts`
 *   include a {@link HITL_REQUEST_TYPE} DataPart (plus a human-readable TextPart).
 * - The gateway renders it in Slack, captures the answer, and resumes the task
 *   with a new message carrying a {@link HITL_RESPONSE_TYPE} DataPart.
 * - On TTL expiry the gateway sends a {@link HITL_TIMEOUT_TYPE} DataPart instead.
 *
 * An "approval" is just a two-option "choice" (Approve/Reject), so one shape
 * covers both.
 */

/** DataPart `data.type` for an agent → gateway HITL request. */
export const HITL_REQUEST_TYPE = "io.looping.hitl.request";
/** DataPart `data.type` for the gateway → agent answer that resumes the task. */
export const HITL_RESPONSE_TYPE = "io.looping.hitl.response";
/** DataPart `data.type` for the gateway → agent timeout that ends the wait. */
export const HITL_TIMEOUT_TYPE = "io.looping.hitl.timeout";

/** Canonical option ids used when an `approval` request omits its own options. */
export const HITL_APPROVE_OPTION_ID = "approve";
export const HITL_REJECT_OPTION_ID = "reject";

const optionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  // Maps to Slack's button/option style; "danger" is the natural Reject accent.
  style: z.enum(["primary", "danger", "default"]).optional()
});

/** An agent → gateway request to ask a human to approve or choose. */
export const hitlRequestSchema = z.object({
  type: z.literal(HITL_REQUEST_TYPE),
  /** Agent-chosen, unique per request — the Slack action + gateway correlation key. */
  requestId: z.string().min(1),
  requestKind: z.enum(["approval", "choice"]),
  prompt: z.string().min(1),
  /** Omit for `approval` to accept the canonical Approve/Reject pair. */
  options: z.array(optionSchema).optional(),
  display: z.enum(["buttons", "radio", "select"]).optional(),
  /** Allow a typed "Something else…" answer alongside the fixed options. */
  allowFreeform: z.boolean().optional()
});

export type HitlRequest = z.infer<typeof hitlRequestSchema>;
export type HitlOption = z.infer<typeof optionSchema>;

/**
 * Find and validate a HITL request in an A2A message's parts. Returns `null`
 * when the message carries no (valid) HITL request DataPart — the caller then
 * falls back to treating the `input-required` update as plain text.
 */
export function parseHitlRequest(
  message: Message | undefined
): HitlRequest | null {
  if (!message) return null;
  for (const part of message.parts) {
    if (part.kind !== "data") continue;
    const data = part.data;
    if (!isRecord(data) || data.type !== HITL_REQUEST_TYPE) continue;
    const parsed = hitlRequestSchema.safeParse(data);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** The canonical two options for an `approval` request that supplies none. */
export function approvalOptions(): SlackInputOption[] {
  return [
    { id: HITL_APPROVE_OPTION_ID, label: "Approve", style: "primary" },
    { id: HITL_REJECT_OPTION_ID, label: "Reject", style: "danger" }
  ];
}

/**
 * Map a validated {@link HitlRequest} onto the Slack SDK's `SlackInputRequest`,
 * filling the canonical Approve/Reject options when an `approval` omits its own.
 * The shapes are intentionally close, so this is mostly a rename plus defaulting.
 */
export function toSlackInputRequest(req: HitlRequest): SlackInputRequest {
  const options: SlackInputOption[] | undefined = req.options
    ? req.options.map((o) => ({
        id: o.id,
        label: o.label,
        description: o.description,
        style: o.style
      }))
    : req.requestKind === "approval"
      ? approvalOptions()
      : undefined;

  return {
    prompt: req.prompt,
    requestId: req.requestId,
    display: req.display ?? "buttons",
    allowFreeform: req.allowFreeform,
    options
  };
}

/** Look up an option's human label by id, for the resume TextPart / answered UI. */
export function optionLabel(
  options: readonly SlackInputOption[],
  optionId: string | undefined
): string | undefined {
  if (!optionId) return undefined;
  return options.find((o) => o.id === optionId)?.label;
}

/**
 * Build the parts of the resume message the gateway sends back onto the task.
 * `humanText` (the chosen option's label, or the freeform text) is the
 * TextPart a non-HITL client sees; the DataPart carries the structured answer.
 */
export function buildHitlResponseParts(input: {
  requestId: string;
  optionId?: string;
  text?: string;
  answeredBy: string;
  humanText: string;
}): Part[] {
  return [
    { kind: "text", text: input.humanText },
    {
      kind: "data",
      data: {
        type: HITL_RESPONSE_TYPE,
        requestId: input.requestId,
        ...(input.optionId ? { optionId: input.optionId } : {}),
        ...(input.text ? { text: input.text } : {}),
        answeredBy: input.answeredBy
      }
    }
  ];
}

/** Build the parts of the timeout message sent when a HITL prompt expires. */
export function buildHitlTimeoutParts(requestId: string): Part[] {
  return [
    {
      kind: "text",
      text: "(No response was received within the allotted time.)"
    },
    { kind: "data", data: { type: HITL_TIMEOUT_TYPE, requestId } }
  ];
}

/**
 * Build the parts of the `input-required` status message an agent emits to raise
 * a HITL prompt: a human-readable TextPart fallback plus the structured request
 * DataPart the gateway renders in Slack. Symmetric to {@link buildHitlResponseParts};
 * the DataPart round-trips through {@link parseHitlRequest}.
 */
export function buildHitlRequestParts(req: HitlRequest): Part[] {
  return [
    { kind: "text", text: req.prompt },
    { kind: "data", data: { ...req, type: HITL_REQUEST_TYPE } }
  ];
}

const hitlResponseSchema = z
  .object({
    type: z.literal(HITL_RESPONSE_TYPE),
    requestId: z.string().min(1),
    optionId: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    answeredBy: z.string().min(1)
  })
  .refine((data) => data.optionId !== undefined || data.text !== undefined, {
    message: "HITL response must include optionId or text"
  });

export type HitlResponse = z.infer<typeof hitlResponseSchema>;

/** Find the DataPart of `type` in a message and validate it with `schema`. */
function parseDataPart<T>(
  message: Message | undefined,
  type: string,
  schema: z.ZodType<T>
): T | null {
  if (!message) return null;
  for (const part of message.parts) {
    if (part.kind !== "data") continue;
    const data = part.data;
    if (!isRecord(data) || data.type !== type) continue;
    const parsed = schema.safeParse(data);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * Find and validate the gateway → agent answer that resumes a parked task.
 * Returns `null` when the message carries no HITL response DataPart.
 */
export function parseHitlResponse(
  message: Message | undefined
): HitlResponse | null {
  return parseDataPart(message, HITL_RESPONSE_TYPE, hitlResponseSchema);
}

const hitlTimeoutSchema = z.object({
  type: z.literal(HITL_TIMEOUT_TYPE),
  requestId: z.string().min(1)
});

/**
 * Find and validate the gateway → agent timeout that ends a parked task's wait.
 * Returns `null` when the message carries no HITL timeout DataPart.
 */
export function parseHitlTimeout(
  message: Message | undefined
): { requestId: string } | null {
  const parsed = parseDataPart(message, HITL_TIMEOUT_TYPE, hitlTimeoutSchema);
  return parsed ? { requestId: parsed.requestId } : null;
}
