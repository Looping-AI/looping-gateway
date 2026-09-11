import type { Message } from "@a2a-js/sdk";
import {
  parseHitlResponse,
  parseHitlTimeout,
  type HitlRequest
} from "@/a2a/hitl";
import { textOf } from "@/a2a/parts";
import {
  ASK_USER_TOOL_NAME,
  askUserInputSchema,
  askUserRequest
} from "./ask-user";
import type { ToolRecord } from "./messages";

/**
 * A turn that stops to ask a human, and the later turn that picks the answer up.
 *
 * The call a turn paused on is kept **outside** the Session, in a record keyed by
 * the HITL `requestId`. Keeping it in history as a pending tool part looks simpler
 * and does not survive use: compaction folds older messages into a summary once
 * history passes its threshold, so a question asked a few turns ago stops being
 * there to find by the time anyone answers it. A record nothing compacts, taken
 * exactly once, has none of that problem — and taking it is also what makes an
 * answer count at most once.
 *
 * On the way back the answered call is put at the *end* of the history the model
 * reads, as the call plus its result, and no user turn is added: the model asked a
 * question, and what it gets back is the answer to that question.
 */

/** A tool call a turn paused on, kept until a human answers it. */
export interface OpenPrompt {
  /** The HITL correlation key the gatekeeper renders and answers with. */
  requestId: string;
  toolCallId: string;
  toolName: string;
  /** The call's input, as the SDK validated it. */
  input: unknown;
  /** Epoch ms — a prompt stopped with 🛑 is never answered, so it has to age out. */
  createdAt: number;
}

/** Where open prompts wait. Implemented over DO storage by `DurableOpenPrompts`. */
export interface OpenPromptStore {
  /** Keep a prompt until it is answered. Also drops prompts past the HITL TTL. */
  put(prompt: OpenPrompt): Promise<void>;
  /** Read-and-delete: a prompt is answered at most once. */
  take(requestId: string): Promise<OpenPrompt | null>;
}

/**
 * Recorded for a call that would have paused the turn but was not raised. One
 * prompt is open per turn, so the rest never reached anyone — and a later turn
 * should be able to see that they were not asked, rather than guess.
 */
export const NOT_ASKED_NOTE =
  "Not asked: only one question can be open at a time. Ask again once this one is answered.";

/** The prompt a step paused on, plus the calls it could not also raise. */
export interface Pause {
  prompt: OpenPrompt;
  notRaised: ToolRecord[];
}

interface CallLike {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** A call that was not raised, recorded as such. */
export function notAsked(call: CallLike): ToolRecord {
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    errorText: NOT_ASKED_NOTE
  };
}

/**
 * The prompt a turn's last step paused on, or `undefined` if it did not pause.
 *
 * Reads `staticToolCalls`, which holds only calls whose input passed the tool's
 * schema — a malformed question was already handed back to the model as a failed
 * result and never stopped the loop.
 *
 * The `requestId` is minted here rather than borrowed from the call. Provider call
 * ids come in whatever shape and length the provider chooses, and this id ends up
 * inside a Slack action id, which Slack caps.
 */
export function openPromptOf(
  step: { staticToolCalls: readonly CallLike[] },
  now = Date.now()
): Pause | undefined {
  const [first, ...rest] = step.staticToolCalls.filter(
    (c) => c.toolName === ASK_USER_TOOL_NAME
  );
  if (!first) return undefined;
  return {
    prompt: {
      requestId: crypto.randomUUID(),
      toolCallId: first.toolCallId,
      toolName: first.toolName,
      input: first.input,
      createdAt: now
    },
    notRaised: rest.map(notAsked)
  };
}

/**
 * The HITL request a prompt renders as. Parsed rather than cast: the input was
 * validated when the model made the call, but it has since been through storage.
 */
export function hitlRequestOf(prompt: OpenPrompt): HitlRequest {
  return askUserRequest(
    prompt.requestId,
    askUserInputSchema.parse(prompt.input)
  );
}

/** What came back for an open prompt. */
export type PromptAnswer =
  { kind: "answered"; text: string; by: string } | { kind: "timed-out" };

/**
 * The answer an inbound message carries, if it is the gatekeeper resuming a parked
 * task. `answerer` is the display name of whoever answered, when the caller knows
 * it; the Slack id on the response stands in otherwise. The text is the message's
 * own text part, which the gatekeeper fills with the chosen label or the typed
 * answer.
 */
export function promptAnswerOf(
  message: Message,
  answerer: string | null | undefined
): { requestId: string; answer: PromptAnswer } | null {
  const response = parseHitlResponse(message);
  if (response) {
    return {
      requestId: response.requestId,
      answer: {
        kind: "answered",
        text: textOf(message),
        by: answerer ?? response.answeredBy
      }
    };
  }
  const timeout = parseHitlTimeout(message);
  return timeout
    ? { requestId: timeout.requestId, answer: { kind: "timed-out" } }
    : null;
}

/**
 * The paused call with its answer as the result — how the model reads it on the
 * turn that resumes, and how that turn records it.
 *
 * A timeout is an ordinary result, not a failed call. A failure reads as "fix the
 * arguments and try again", and asking the same question again a week later is not
 * what an unanswered question calls for.
 */
export function answeredCall(
  prompt: OpenPrompt,
  answer: PromptAnswer
): ToolRecord {
  return {
    toolCallId: prompt.toolCallId,
    toolName: prompt.toolName,
    input: prompt.input,
    output:
      answer.kind === "answered"
        ? { answer: answer.text, answeredBy: answer.by }
        : {
            answered: false,
            note: "No answer came back within the allotted time."
          }
  };
}
