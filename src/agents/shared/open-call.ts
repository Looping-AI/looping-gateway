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
 * there to find by the time anyone answers it. A record nothing compacts has none of
 * that problem.
 *
 * This is the agent's own copy, and it holds what only the agent needs: which call
 * the answer belongs to. The human-facing half — prompt text, options, status,
 * deadline — is the gatekeeper's `hitl_requests` row, and the two meet on the
 * `requestId` alone.
 *
 * On the way back the answered call is written to the *end* of history, as the call
 * plus its result, and no user turn is added: the model asked a question, and what
 * it gets back is the answer to that question. The record is forgotten only once
 * that write has landed — the gatekeeper will not send the answer twice, so the
 * record is the last copy until history holds it.
 */

/** A tool call a turn paused on, kept until a human answers it. */
export interface OpenCall {
  /** The HITL correlation key the gatekeeper renders and answers with. */
  requestId: string;
  toolCallId: string;
  toolName: string;
  /** The call's input, as the SDK validated it. */
  input: unknown;
  /** Epoch ms — a call stopped with 🛑 is never answered, so it has to age out. */
  createdAt: number;
}

/** Where open calls wait. Implemented over DO storage by `DurableOpenCalls`. */
export interface OpenCallStore {
  /** Keep a call until it is answered. Also drops calls past the HITL TTL. */
  put(call: OpenCall): Promise<void>;
  /**
   * Hand the call `requestId` answers to `record`, then forget it — only after
   * `record` has finished, and not at all if it throws. Null, with `record` never
   * called, when there is no such call: never asked, or already settled.
   */
  settle(
    requestId: string,
    record: (call: OpenCall) => Promise<void>
  ): Promise<OpenCall | null>;
}

/**
 * Recorded for a call that would have paused the turn but was not raised. One
 * call is open per turn, so the rest never reached anyone — and a later turn
 * should be able to see that they were not asked, rather than guess.
 */
export const NOT_ASKED_NOTE =
  "Not asked: only one question can be open at a time. Ask again once this one is answered.";

/** The call a step paused on, plus the calls it could not also raise. */
export interface Pause {
  call: OpenCall;
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
 * The call a turn's last step paused on, or `undefined` if it did not pause.
 *
 * Reads `staticToolCalls`, which holds only calls whose input passed the tool's
 * schema — a malformed question was already handed back to the model as a failed
 * result and never stopped the loop.
 *
 * The `requestId` is minted here rather than borrowed from the call. Provider call
 * ids come in whatever shape and length the provider chooses, and this id ends up
 * inside a Slack action id, which Slack caps.
 */
export function openCallOf(
  step: { staticToolCalls: readonly CallLike[] },
  now = Date.now()
): Pause | undefined {
  const [first, ...rest] = step.staticToolCalls.filter(
    (c) => c.toolName === ASK_USER_TOOL_NAME
  );
  if (!first) return undefined;
  return {
    call: {
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
 * The HITL request a call renders as. Parsed rather than cast: the input was
 * validated when the model made the call, but it has since been through storage.
 */
export function hitlRequestOf(call: OpenCall): HitlRequest {
  return askUserRequest(call.requestId, askUserInputSchema.parse(call.input));
}

/** What came back for an open call. */
export type HumanAnswer =
  { kind: "answered"; text: string; by: string } | { kind: "timed-out" };

/**
 * The answer an inbound message carries, if it is the gatekeeper resuming a parked
 * task. `answerer` is the display name of whoever answered, when the caller knows
 * it; the Slack id on the response stands in otherwise. The text is the message's
 * own text part, which the gatekeeper fills with the chosen label or the typed
 * answer.
 */
export function humanAnswerOf(
  message: Message,
  answerer: string | null | undefined
): { requestId: string; answer: HumanAnswer } | null {
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
export function answeredCall(call: OpenCall, answer: HumanAnswer): ToolRecord {
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    output:
      answer.kind === "answered"
        ? { answer: answer.text, answeredBy: answer.by }
        : {
            answered: false,
            note: "No answer came back within the allotted time."
          }
  };
}
