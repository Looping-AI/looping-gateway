import { AgentEvent } from "@a2a-js/sdk/server";
import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { Role, TaskState } from "@a2a-js/sdk";
import type { Message } from "@a2a-js/sdk";
import type {
  FinishReason,
  GenerateTextOnStepEndCallback,
  LanguageModel,
  ModelMessage,
  PrepareStepFunction,
  StopCondition,
  ToolSet
} from "ai";
import {
  APICallError,
  generateText,
  isStepCount,
  RetryError,
  ToolChoiceViolationError
} from "ai";
import { CHAT_CALL_OPTIONS } from "@/agents/model";
import { buildMessage, textOf, textPart } from "@/a2a/parts";
import { buildHitlRequestParts, type HitlRequest } from "@/a2a/hitl";
import type { AgentTurnMetadata } from "@/agents/dispatch";
import type { SessionLike } from "./session";
import {
  assistantSessionMessage,
  toModelMessages,
  toolCallSessionMessage,
  userSessionMessage,
  type ToolRecord
} from "./messages";
import {
  FINAL_REPLY_CONTRACT,
  FINAL_REPLY_TOOL_NAME,
  FINAL_ROUND_CONTRACT,
  finalReplyInputSchema,
  finalReplyTool
} from "./final-reply";
import {
  answeredCall,
  hitlRequestOf,
  notAsked,
  openPromptOf,
  promptAnswerOf,
  type OpenPromptStore
} from "./open-prompt";

/**
 * How many model calls one turn may spend.
 *
 * Under the forced ending the last of them is not a work step — it is the answer
 * (see `endingStep`), so nine steps do the work and the tenth reports it. The
 * reservation is the point: a budget that simply ran out would discard everything
 * the turn did and apologize for an outage that never happened.
 */
const MAX_STEPS = 10;

const TRANSIENT_REPLY =
  "The AI service is temporarily unavailable. Please try again in a moment.";

/** Recorded in history when a turn is stopped, so it doesn't read as unanswered. */
const CANCELED_NOTE = "(stopped by the user; reply was not delivered)";

/**
 * Recorded when a turn ran tools but never produced a reply. The apology the user
 * sees is not persisted — it says nothing true about the workspace — but the calls
 * did run, and a side effect the transcript does not show is exactly how a later
 * turn ends up guessing.
 */
const NO_REPLY_NOTE =
  "(no reply was produced for this turn; the actions above did run)";

/**
 * The reply a forced-ending call landed on, or `undefined` if it produced none.
 *
 * `staticToolCalls` holds only calls whose input passed the tool's own schema: the
 * SDK validates every call, marks a rejected one `dynamic`, and this getter filters
 * those out. So a call found here is already valid, and the parse below is how its
 * input is read back *with a type* rather than a second check — it is the same
 * schema object `finalReplyTool` declares, so the two cannot disagree.
 *
 * Typed by what it reads rather than as `GenerateTextResult`, whose three type
 * parameters describe a tool set this turn only assembles at runtime — and so that
 * the one-tool salvage call can be read by the same function.
 */
function readFinalReply(result: {
  finalStep: {
    staticToolCalls: readonly { toolName: string; input: unknown }[];
  };
}): string | undefined {
  const calls = result.finalStep.staticToolCalls.filter(
    (c) => c.toolName === FINAL_REPLY_TOOL_NAME
  );
  if (calls.length === 0) return undefined;
  // The last call of a repeated set: a model that restated its answer meant the
  // restatement.
  const parsed = finalReplyInputSchema.safeParse(calls[calls.length - 1].input);
  return parsed.success ? parsed.data.text.trim() : undefined;
}

/**
 * The reply a plain-text turn landed on. `length` means the model was cut off
 * mid-sentence, which is not an answer however much of one it looks like.
 */
function readPlainReply(result: {
  text: string;
  finishReason: FinishReason;
}): string | undefined {
  const text = result.text.trim();
  return text.length > 0 && result.finishReason !== "length" ? text : undefined;
}

/**
 * Whether a failure is the service being briefly unavailable rather than a bug —
 * the difference between "try again in a moment" and an apology.
 *
 * The SDK decides this now, not us. The provider normalizes a binding failure into
 * an `APICallError` carrying an HTTP status, and `isRetryable` is exactly the
 * question being asked here (429, 408, 409, 5xx). A failure the SDK retried arrives
 * wrapped, and the wrapper's own message ("Failed after N attempts") carries none of
 * that signal, so unwrap before classifying.
 *
 * One known gap: Workers AI code 3046 is missing from the provider's code→status
 * table, so it reaches us with no status at all and reads as permanent. That used to
 * be caught by matching the message text — which also matched any error that merely
 * mentioned the number. Fixing it belongs upstream, in the table, not here.
 */
export function isTransientAiError(err: unknown): boolean {
  if (RetryError.isInstance(err)) return isTransientAiError(err.lastError);
  if (APICallError.isInstance(err)) return err.isRetryable;
  return false;
}

/** What to log as the model. A `LanguageModel` may be a bare model-id string. */
function modelIdOf(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

/** What an agent assembles for a single turn (inside the protected body). */
export interface PreparedTurn {
  /** The Durable Object's one Session (history + soul + memory). */
  session: SessionLike;
  /** Per-request system-prompt suffix (caller context). Advisory. */
  systemSuffix: string;
  /** Agent-specific tools merged over the session's own `set_context` tool. */
  tools: ToolSet;
}

/** Turn-scoped controls a tool can reach (via the deps its executor builds). */
export interface TurnControls {
  /**
   * Pause this turn to ask a human: the loop stops after the current tool step,
   * ends the turn in `input-required` carrying `request` (the delivery boundary
   * renders it in Slack and parks the task), and publishes no terminal reply. The
   * human's answer resumes the agent on a later, separate invocation.
   */
  park(request: HitlRequest): void;
}

export interface AgentTurnConfig {
  /**
   * The one model a turn runs on. It carries its own fallback — see
   * {@link file://../model-fallback-middleware.ts model-fallback-middleware.ts} —
   * so a second model is not this layer's concern.
   */
  model: LanguageModel;
  /**
   * Assemble the session/tools/system for this turn. Runs *inside* the protected
   * body, so throwing here (e.g. missing required metadata) yields the friendly
   * error reply rather than a crash. `turn` lets the assembled tools pause the
   * turn for human input (agents that don't offer HITL simply ignore it).
   */
  prepare: (
    text: string,
    metadata: Partial<AgentTurnMetadata>,
    turn: TurnControls
  ) => Promise<PreparedTurn>;
  /** Friendly reply for an unexpected (non-transient) failure. */
  unexpectedReply: string;
  /**
   * Whether a 🛑 has been recorded for this turn, keyed by the dispatch token
   * (the A2A `messageId`). Consulted between tool-calling steps; `true` ends the
   * turn with no reply. Optional so a unit test can drive a turn nothing stops.
   */
  isCanceled?: (token: string) => Promise<boolean>;
  /**
   * Make the turn end in a `final_reply` tool call instead of in plain text, with
   * `toolChoice: "required"` on every working step and the ending *named* on the
   * last. Prose stops being an outcome, so a model that narrates an action and
   * stops fails its attempt rather than shipping the narration as an answer — see
   * {@link file://./final-reply.ts final-reply.ts}.
   *
   * Off by default: an agent that has not opted in keeps the plain-text ending.
   */
  requireFinalReply?: boolean;
  /**
   * Persist the tool calls the turn actually made into session history alongside
   * the reply, so a later turn can see what really happened rather than only what
   * this one claimed. Off by default. See {@link assistantSessionMessage}.
   */
  recordToolCalls?: boolean;
  /**
   * Where a turn that stops to ask a human keeps the call it paused on, until the
   * answer resumes it — see {@link file://./open-prompt.ts open-prompt.ts}. Needed
   * by any agent whose tools include `ask_user`: a turn that has to pause without
   * one fails, because the question it would raise could never be answered.
   */
  openPrompts?: OpenPromptStore;
}

function agentMessage(
  requestContext: RequestContext,
  messageId: string,
  parts: Message["parts"]
): Message {
  return buildMessage({
    messageId,
    role: Role.ROLE_AGENT,
    parts,
    taskId: requestContext.taskId,
    contextId: requestContext.contextId
  });
}

/**
 * Publish the initial `submitted` Task. Every A2A v1.0 execution MUST open with
 * a `task` or `message` event — the server rejects a stream that starts with a
 * status update — and events are wrapped in the discriminated `AgentEvent`
 * envelope rather than published as bare objects.
 */
function publishSubmitted(
  eventBus: ExecutionEventBus,
  requestContext: RequestContext
): void {
  eventBus.publish(
    AgentEvent.task({
      id: requestContext.taskId,
      contextId: requestContext.contextId,
      status: {
        state: TaskState.TASK_STATE_SUBMITTED,
        message: undefined,
        timestamp: undefined
      },
      artifacts: [],
      history: [],
      metadata: undefined
    })
  );
}

/**
 * Publish a status update. v1.0 dropped `TaskStatusUpdateEvent.final`: the state
 * itself now says whether the stream is over, so a terminal (or interrupted)
 * state closes the turn and `working` keeps it open.
 */
function publishStatus(
  eventBus: ExecutionEventBus,
  requestContext: RequestContext,
  parts: Message["parts"],
  messageId: string,
  state: TaskState
): void {
  eventBus.publish(
    AgentEvent.statusUpdate({
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      status: {
        state,
        message: agentMessage(requestContext, messageId, parts),
        timestamp: undefined
      },
      metadata: undefined
    })
  );
}

/**
 * End the turn in `input-required`, carrying the HITL request data part (plus
 * its text-part fallback). The state is *interrupted*, not terminal: it closes
 * this interaction's event stream while leaving the task resumable on a later
 * invocation when the human answers. The delivery boundary detects the data
 * part and renders it as an interactive Slack prompt (see `deliverHitlRequest`).
 */
function publishInputRequired(
  eventBus: ExecutionEventBus,
  requestContext: RequestContext,
  request: HitlRequest,
  messageId: string
): void {
  publishStatus(
    eventBus,
    requestContext,
    buildHitlRequestParts(request),
    messageId,
    TaskState.TASK_STATE_INPUT_REQUIRED
  );
}

/**
 * The generic agent turn shared by every in-repo agent: append the user message,
 * run **one** Workers-AI `generateText` tool loop over the Session history, persist
 * + publish the final reply, and always `finished()`. Agent-specific behavior
 * (which session, which tools, which caller context) is supplied by `cfg.prepare`.
 *
 * One call, because the SDK's loop already owns everything this used to re-implement
 * around it: a rejected ending comes back to the model as a failed tool result on the
 * next step, the forced final round is that loop's last step, and an unreachable
 * model is answered a layer down by the model's own fallback. The single exception is
 * `salvageEnding` below, for a turn the loop leaves with no answer at all.
 */
export async function executeAgentTurn(
  requestContext: RequestContext,
  eventBus: ExecutionEventBus,
  cfg: AgentTurnConfig
): Promise<void> {
  const userMessage = requestContext.userMessage;
  const text = textOf(userMessage);
  const metadata = (userMessage.metadata ?? {}) as Partial<AgentTurnMetadata>;
  const modelId = modelIdOf(cfg.model);
  let completed = false;
  // Set by the stop condition below once a 🛑 is seen for this turn.
  let canceled = false;
  // Set when a tool calls `turn.park`: the turn ends in `input-required` awaiting
  // a human instead of publishing a terminal reply. Held on an object so the
  // closure assignment in `turn.park` is visible to control-flow narrowing.
  const hitl: { request: HitlRequest | null } = { request: null };
  // Tracks the text of the most recent non-terminal step published below, so the
  // terminal reply isn't posted twice when it is that same text.
  let lastStepText = "";

  publishSubmitted(eventBus, requestContext);

  const publishTerminal = (
    reply: string,
    state: TaskState = TaskState.TASK_STATE_COMPLETED
  ): void => {
    if (completed) return;
    completed = true;
    // When generation stops at the step limit on a tool-calling step, that step's
    // text was already streamed as a non-terminal update (`:step:N`) and equals
    // `result.text`. Send an empty terminal so the task still completes and
    // collects the 🛑 without re-posting it (different id ⇒ dedupe would miss it).
    // History still keeps the full reply via `appendMessage`.
    const terminalText = reply && reply === lastStepText ? "" : reply;
    publishStatus(
      eventBus,
      requestContext,
      [textPart(terminalText)],
      `${userMessage.messageId}:final`,
      state
    );
  };

  try {
    const turn: TurnControls = {
      park: (request) => {
        hitl.request = request;
      }
    };
    const {
      session,
      systemSuffix,
      tools: extraTools
    } = await cfg.prepare(text, metadata, turn);

    // An answer to a question this agent asked resumes that call rather than opening
    // a new exchange: the call, with the answer as its result, goes where the model
    // left off, and no user turn is added — the answer *is* the result.
    //
    // It is written to history first, before the model runs and before the store lets
    // go of its copy. The gatekeeper has already marked the answer as given and will
    // not send it again, so a turn that recorded it only on the way out could lose it
    // to anything that ends the turn early — a failure, or a reset of this object.
    // An answer with no prompt left to settle (asked before open prompts existed, or
    // already settled) is an ordinary message.
    const answer = promptAnswerOf(userMessage, metadata.user?.displayName);
    const settled =
      answer && cfg.openPrompts
        ? await cfg.openPrompts.settle(answer.requestId, async (prompt) => {
            await session.appendMessage(
              toolCallSessionMessage(
                answeredCall(prompt, answer.answer),
                // Fixed per prompt, so recording the same answer twice stores it once.
                `answer:${prompt.requestId}`
              )
            );
          })
        : null;
    if (settled) {
      console.info("[agent-loop] resuming an answered question", {
        requestId: settled.requestId,
        contextId: requestContext.contextId
      });
    } else {
      // `text` already carries its `<turn>` provenance wrapper (applied by the
      // Gatekeeper in dispatch); persist it verbatim.
      await session.appendMessage(userSessionMessage(text));
    }
    const history = await session.getHistory();
    const soul = (await session.refreshSystemPrompt()) + systemSuffix;
    const workTools = { ...(await session.tools()), ...extraTools };
    const messages = await toModelMessages(history);
    const required = cfg.requireFinalReply === true;

    // Every tool call this turn actually executed, across every attempt — the
    // primary's, a repair's, and the fallback's alike. All of them really ran and
    // really had side effects, so all of them are recorded: a fallback that
    // repeated an update performed two updates, and history should say so.
    //
    // `final_reply` never appears here. It has no `execute`, so it produces no
    // result to record — its text is the message body, not an action.
    const actions: ToolRecord[] = [];

    const onStepEnd: GenerateTextOnStepEndCallback<ToolSet> = (step) => {
      if (cfg.recordToolCalls) {
        for (const part of step.content) {
          if (part.type === "tool-result") {
            actions.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              output: part.output
            });
          } else if (part.type === "tool-error") {
            // "I tried and it failed" is precisely the evidence that stops the
            // next turn confirming a success that never happened.
            actions.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              errorText: String(part.error)
            });
          }
        }
      }
      // Text from a tool-calling step is the agent's only genuine non-terminal
      // content. Tool-only steps stay silent in Slack.
      if (step.toolCalls.length === 0 || !step.text.trim()) return;
      // The step that ends the turn carries the answer in its `final_reply` call.
      // Publishing its accompanying text too would post the same thought twice —
      // once as a `working` update, once as the reply.
      if (step.toolCalls.some((c) => c.toolName === FINAL_REPLY_TOOL_NAME))
        return;
      const stepText = step.text.trim();
      lastStepText = stepText;
      publishStatus(
        eventBus,
        requestContext,
        [textPart(stepText)],
        `${userMessage.messageId}:step:${step.stepNumber}`,
        TaskState.TASK_STATE_WORKING
      );
    };

    // The gatekeeper's 🛑 workflow runs on its own request and cannot reach into
    // this Durable Object mid-turn, so it records the stop on the task row and
    // the turn reads it back from there.
    const checkCanceled = async (): Promise<boolean> => {
      if (!cfg.isCanceled || canceled) return canceled;
      try {
        canceled = await cfg.isCanceled(userMessage.messageId);
      } catch (err) {
        // A ledger hiccup must not kill a turn that was never asked to stop.
        console.warn("[agent-loop] stop check failed, continuing", {
          contextId: requestContext.contextId,
          err: String(err)
        });
        return false;
      }
      return canceled;
    };

    // Between tool-calling steps — the only place generation can be *interrupted*.
    // A step's tool calls have already run and their results still reach the model.
    const stopIfCanceled: StopCondition<ToolSet> = () => checkCanceled();

    // A tool called `turn.park`: stop right after this step so the turn can end in
    // `input-required` instead of feeding the sentinel result back to the model.
    const stopIfHitlRequested: StopCondition<ToolSet> = () =>
      hitl.request !== null;

    // The system prompt goes in `instructions`: `messages` rejects `role: "system"`
    // entries by default, which is fine because `toModelMessages` only ever emits
    // user/assistant turns.
    const instructions = soul + (required ? FINAL_REPLY_CONTRACT : "");

    /**
     * The last step is the ending, not one more chance to work.
     *
     * Handing it only `final_reply` explains a constraint the model can already see
     * rather than imposing a new one — and the *named* tool choice is the stronger
     * form of the same ask: Workers AI enforces it server-side, where `required` is
     * advisory and fails open into prose on long contexts, which is the exact failure
     * this whole design exists to catch.
     *
     * Unlike the separate round it replaces, this step is inside the loop, so it can
     * see every tool result the turn produced. The old one restarted from history and
     * was asked to report work it could not read.
     */
    const endingStep: PrepareStepFunction<ToolSet> = ({ stepNumber }) =>
      stepNumber < MAX_STEPS - 1
        ? undefined
        : {
            activeTools: [FINAL_REPLY_TOOL_NAME],
            toolChoice: { type: "tool", toolName: FINAL_REPLY_TOOL_NAME },
            instructions: instructions + FINAL_ROUND_CONTRACT
          };

    const runTurn = () =>
      generateText({
        model: cfg.model,
        instructions,
        messages,
        // `final_reply` is declared *first*: tool order is part of the prompt, and
        // reaching an ending is the thing every turn has to do.
        tools: required
          ? { [FINAL_REPLY_TOOL_NAME]: finalReplyTool, ...workTools }
          : workTools,
        // Every ending is a `final_reply` call, so the model must always call
        // something. Work tools stay freely available — `required` constrains the
        // *shape* of a step's output, not which tool is chosen.
        ...(required
          ? { toolChoice: "required" as const, prepareStep: endingStep }
          : {}),
        // `hasToolCall(FINAL_REPLY_TOOL_NAME)` is deliberately absent here: it matches
        // a *rejected* call too, so it would halt the loop on a malformed ending
        // before the SDK could hand the model its own error to fix. A valid call ends
        // the loop without help — `final_reply` has no `execute`, so it produces no
        // output, and the loop only continues once every call has one.
        stopWhen: [isStepCount(MAX_STEPS), stopIfCanceled, stopIfHitlRequested],
        onStepEnd,
        // `reasoning` and the telemetry opt-out travel together, shared with the
        // compaction summarizer so the two call sites cannot drift — see
        // {@link file://../model.ts model.ts}.
        ...CHAT_CALL_OPTIONS
      });

    /**
     * Ask for an ending, once, with nothing else on the table.
     *
     * Reached only when the loop came back with no reply: the model narrated under
     * the advisory `required` and the SDK raised the violation, or the ending step's
     * own call was malformed with no budget left to repair it. Both are endings the
     * turn can still recover, and the enforced tool choice is the one lever the
     * failed steps did not have.
     *
     * No `onStepEnd`: nothing but the reply is declared, so there is no action to
     * record and no intermediate text to publish.
     */
    const salvageEnding = (seed: ModelMessage[]) =>
      generateText({
        model: cfg.model,
        instructions: instructions + FINAL_ROUND_CONTRACT,
        messages: seed,
        tools: { [FINAL_REPLY_TOOL_NAME]: finalReplyTool },
        toolChoice: { type: "tool", toolName: FINAL_REPLY_TOOL_NAME },
        stopWhen: [isStepCount(1)],
        ...CHAT_CALL_OPTIONS
      });

    let result: Awaited<ReturnType<typeof runTurn>> | undefined;
    let reply: string | undefined;

    try {
      result = await runTurn();
      reply = required ? readFinalReply(result) : readPlainReply(result);
    } catch (err) {
      // Narration under an enforced tool choice arrives as a throw, not a result —
      // the SDK enforces the constraint it cannot make the model honour, and it only
      // does so once the model's own fallback has answered in prose too. It is an
      // *ending*, not an outage: both models were reachable and answered, they just
      // answered in prose. Catching it here keeps the turn off the failure path and
      // on the one that asks once more for an answer.
      if (!ToolChoiceViolationError.isInstance(err)) throw err;
      console.warn("[agent-loop] narrated under an enforced tool choice", {
        model: modelId,
        finishReason: err.finishReason,
        contextId: requestContext.contextId
      });
    }

    // The question the last step stopped on, if it stopped on one.
    const pause = result ? openPromptOf(result.finalStep) : undefined;

    // A 🛑, a park, or a question out-ranks the reply and ends the turn here: none
    // of them is a reason to spend another call.
    const interrupted =
      (await checkCanceled()) || hitl.request !== null || pause !== undefined;

    if (required && reply === undefined && !interrupted) {
      console.warn("[agent-loop] no ending; asking once more with none else", {
        model: modelId,
        finishReason: result?.finishReason,
        contextId: requestContext.contextId
      });
      try {
        // With a result there is a whole run to report, so hand it over. A violation
        // discards the run, leaving only history — which is all the round this
        // replaces ever had.
        const salvaged = await salvageEnding([
          ...messages,
          ...(result?.responseMessages ?? [])
        ]);
        reply = readFinalReply(salvaged);
      } catch (err) {
        if (!ToolChoiceViolationError.isInstance(err)) throw err;
        console.warn("[agent-loop] narrated again under the enforced ending", {
          model: modelId,
          contextId: requestContext.contextId
        });
      }
    }

    // Every exit below persists `actions` alongside whatever the turn managed to
    // say. The tools ran and their side effects are real however the turn ended;
    // a side effect the transcript does not show is exactly how a later turn ends
    // up guessing at what happened.

    // Re-check after generation, not only between steps. A turn the model answers
    // in a single step has no step boundary to be interrupted at, and neither does
    // a salvage call, so this is the only chance to notice a 🛑 that landed while
    // either was generating. The work is already spent by then, but the answer must
    // still be withheld: the user was told "🛑 Stopped.", and delivering the reply
    // anyway is the bug this fixes.
    await checkCanceled();

    // Stopped: whatever was produced is abandoned work, not an answer. Publish an
    // empty terminal `canceled` — the gatekeeper posts its own "🛑 Stopped." notice,
    // and any partial output already went out as a step update — and close the
    // turn in history so the next one doesn't reopen it.
    if (canceled) {
      console.info("[agent-loop] turn stopped by the user", {
        contextId: requestContext.contextId,
        model: modelId
      });
      publishTerminal("", TaskState.TASK_STATE_CANCELED);
      await session.appendMessage(
        assistantSessionMessage(CANCELED_NOTE, actions)
      );
      return;
    }

    // A tool paused the turn for human input. Persist the prompt as the assistant's
    // turn so the resumed turn has coherent context (the model "remembers" what it
    // asked), then end in `input-required` — no terminal reply.
    if (hitl.request) {
      completed = true;
      // A question asked in the same step never reached anyone; say so.
      await session.appendMessage(
        assistantSessionMessage(hitl.request.prompt, [
          ...actions,
          ...(pause ? [notAsked(pause.prompt), ...pause.notRaised] : [])
        ])
      );
      publishInputRequired(
        eventBus,
        requestContext,
        hitl.request,
        `${userMessage.messageId}:hitl`
      );
      return;
    }

    // The model asked the human something. Record the question as what this turn
    // said, keep the call until someone answers it, and only then raise the prompt:
    // a click that beat the record would find nothing to resume.
    if (pause) {
      if (!cfg.openPrompts) {
        throw new Error(
          `[agent-loop] ${pause.prompt.toolName} was called, but this agent has nowhere to keep an open prompt`
        );
      }
      const request = hitlRequestOf(pause.prompt);
      await session.appendMessage(
        assistantSessionMessage(request.prompt, [
          ...actions,
          ...pause.notRaised
        ])
      );
      await cfg.openPrompts.put(pause.prompt);
      completed = true;
      publishInputRequired(
        eventBus,
        requestContext,
        request,
        `${userMessage.messageId}:hitl`
      );
      return;
    }

    if (reply === undefined) {
      console.warn("[agent-loop] turn produced no reply", {
        model: modelId,
        // Absent when the turn ended in a violation: the throw carries the result
        // away with it, and the warning above already named that case.
        finishReason: result?.finishReason,
        contextId: requestContext.contextId
      });
      // The apology is not persisted — it says nothing true about the workspace —
      // but any calls that ran are.
      if (actions.length > 0) {
        await session.appendMessage(
          assistantSessionMessage(NO_REPLY_NOTE, actions)
        );
      }
      publishTerminal(TRANSIENT_REPLY);
      return;
    }

    await session.appendMessage(assistantSessionMessage(reply, actions));
    publishTerminal(reply);
  } catch (err) {
    console.error("[agent-loop] turn failed", {
      contextId: requestContext.contextId,
      model: modelId,
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    // A transient blip is a turn that completed by saying "try again" — the work
    // is recoverable and nothing is broken. An unexpected error is a real
    // failure, so report it as one: `failed` is what makes the delivery boundary
    // mark it in Slack instead of rendering the apology as a normal reply. A2A
    // v1.0 carries no structured task error, so the state is the only signal.
    if (isTransientAiError(err)) {
      publishTerminal(TRANSIENT_REPLY);
    } else {
      publishTerminal(cfg.unexpectedReply, TaskState.TASK_STATE_FAILED);
    }
  } finally {
    eventBus.finished();
  }
}
