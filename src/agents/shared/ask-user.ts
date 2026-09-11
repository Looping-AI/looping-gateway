import { tool } from "ai";
import { z } from "zod";
import { HITL_REQUEST_TYPE, type HitlRequest } from "@/a2a/hitl";

/**
 * The `ask_user` **control tool** — how a turn stops to ask a human.
 *
 * It has no `execute`, and that is the whole mechanism. The SDK's loop only moves
 * on once every call in a step has an output; a call to a tool with nothing to run
 * never gets one, so the loop halts on it by itself. No flag, no stop condition.
 * The turn then reads the question off the step, parks the call until someone
 * answers, and the answer comes back on a later invocation as *this call's result*
 * — see {@link file://./open-prompt.ts open-prompt.ts} for the round trip.
 *
 * It lives here rather than among one agent's tools because the turn has to
 * recognize it by name, the same way it recognizes `final_reply`.
 */

export const ASK_USER_TOOL_NAME = "ask_user";

/**
 * The call's input. `min(1)` mirrors `hitlRequestSchema` in `a2a/hitl.ts`: a blank
 * question or label is a request the gatekeeper would refuse to render, and the SDK
 * validates an `execute`-less call like any other — so rejecting it here hands the
 * model its own mistake to fix in the same turn, instead of parking a task on a
 * prompt nobody can see.
 */
export const askUserInputSchema = z.object({
  question: z.string().min(1).describe("The question to ask the human"),
  options: z
    .array(
      z.object({
        label: z.string().min(1).describe("A short, tappable choice"),
        description: z
          .string()
          .optional()
          .describe("Optional one-line clarification of this choice")
      })
    )
    .min(1)
    .max(5)
    .describe("The preset choices to offer (1–5)"),
  allowFreeform: z
    .boolean()
    .optional()
    .describe("Also offer a free-text 'Other' answer (default true)")
});

export type AskUserInput = z.infer<typeof askUserInputSchema>;

/** The tool as the model sees it. **Without `execute`** — see the module note. */
export const askUserTool = tool({
  description:
    "Ask the human a clarifying question when a detail is ambiguous, instead " +
    "of guessing. Renders in Slack as tappable choices and pauses the " +
    "conversation until they answer; their answer comes back as this call's " +
    "result. Give a few concrete options and keep `allowFreeform` on so they can " +
    "also type their own answer.",
  inputSchema: askUserInputSchema
});

/** The HITL request a question renders as: a choice, with a freeform "Other" by default. */
export function askUserRequest(
  requestId: string,
  input: AskUserInput
): HitlRequest {
  return {
    type: HITL_REQUEST_TYPE,
    requestId,
    requestKind: "choice",
    prompt: input.question,
    options: input.options.map((o, i) => ({
      id: `opt_${i}`,
      label: o.label,
      description: o.description
    })),
    display: "buttons",
    allowFreeform: input.allowFreeform ?? true
  };
}
