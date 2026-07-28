import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { tool, type LanguageModel } from "ai";
import { z } from "zod";
import { TaskState, type TaskStatusUpdateEvent } from "@a2a-js/sdk";
import type { AgentExecutionEvent } from "@a2a-js/sdk/server";
import { dataOf, partsText } from "@/a2a/parts";
import type { ModelPair } from "@/agents/model";
import type { SessionLike } from "@/agents/shared/session";
import {
  isTransientAiError,
  executeAgentTurn,
  type AgentTurnConfig
} from "@/agents/shared/loop";
import {
  FakeSession,
  okResult,
  lengthResult,
  toolCallResult
} from "../../helpers/agents";
import { userMessage } from "../../helpers/a2a";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PublishedEvent = AgentExecutionEvent;

function fakeEventBus() {
  const published: PublishedEvent[] = [];
  const publish = vi.fn((e: unknown) => {
    published.push(e as never);
  });
  const finished = vi.fn();
  const eventBus = { publish, finished } as never;
  return { eventBus, published, publish, finished };
}

function fakeRequestContext(
  text = "hello",
  opts: { contextId?: string; metadata?: Record<string, unknown> } = {}
) {
  const contextId = opts.contextId ?? "ctx-1";
  return {
    contextId,
    taskId: "task-1",
    userMessage: userMessage(text, {
      contextId,
      metadata: opts.metadata ?? {}
    })
  } as never;
}

/** The status-update event at `index`, failing the test if it is another kind. */
function statusEventAt(
  bus: { published: PublishedEvent[] },
  index: number
): TaskStatusUpdateEvent {
  const event = bus.published.at(index);
  expect(event?.kind).toBe("statusUpdate");
  return (event as { kind: "statusUpdate"; data: TaskStatusUpdateEvent }).data;
}

/** The task state of every status-update event published, in order. */
function publishedStates(bus: { published: PublishedEvent[] }): TaskState[] {
  return bus.published.flatMap((e) =>
    e.kind === "statusUpdate" && e.data.status ? [e.data.status.state] : []
  );
}

/** The concatenated text of every event published, for "never said X" checks. */
function publishedText(bus: { published: PublishedEvent[] }): string {
  return bus.published
    .map((e) =>
      e.kind === "statusUpdate" ? partsText(e.data.status?.message?.parts) : ""
    )
    .join("");
}

function expectTerminalReply(
  bus: { published: PublishedEvent[] },
  state: TaskState = TaskState.TASK_STATE_COMPLETED
) {
  expect(bus.published[0]).toMatchObject({
    kind: "task",
    data: {
      id: "task-1",
      contextId: "ctx-1",
      status: { state: TaskState.TASK_STATE_SUBMITTED }
    }
  });

  const terminal = statusEventAt(bus, -1);
  expect(terminal).toMatchObject({
    taskId: "task-1",
    contextId: "ctx-1",
    status: { state }
  });
  return terminal.status?.message;
}

function fakeModels(
  primary: LanguageModel,
  fallback: LanguageModel = primary
): ModelPair {
  return {
    primary: () => primary,
    fallback: () => fallback,
    primaryId: () => "primary-model",
    fallbackId: () => "fallback-model"
  };
}

function makeCfg(
  session: SessionLike,
  models: ModelPair,
  overrides: Partial<AgentTurnConfig> = {}
): AgentTurnConfig {
  return {
    models,
    prepare: async () => ({ session, systemSuffix: "", tools: {} }),
    unexpectedReply: "Something went wrong. Please try again.",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// isTransientAiError
// ---------------------------------------------------------------------------

describe("isTransientAiError", () => {
  it("returns false for non-Error values", () => {
    expect(isTransientAiError("string error")).toBe(false);
    expect(isTransientAiError(42)).toBe(false);
    expect(isTransientAiError(null)).toBe(false);
    expect(isTransientAiError(undefined)).toBe(false);
  });

  it("returns true when message contains error code 3040", () => {
    expect(isTransientAiError(new Error("error code 3040 hit"))).toBe(true);
  });

  it("returns true when message contains error code 3046", () => {
    expect(isTransientAiError(new Error("3046 returned from model"))).toBe(
      true
    );
  });

  it("returns true for 'capacity temporarily exceeded' (case-insensitive)", () => {
    expect(isTransientAiError(new Error("Capacity Temporarily Exceeded"))).toBe(
      true
    );
    expect(isTransientAiError(new Error("CAPACITY TEMPORARILY EXCEEDED"))).toBe(
      true
    );
  });

  it("returns true for 'request timeout' (case-insensitive)", () => {
    expect(isTransientAiError(new Error("Request Timeout occurred"))).toBe(
      true
    );
    expect(isTransientAiError(new Error("REQUEST TIMEOUT"))).toBe(true);
  });

  it("returns false for an unrelated error message", () => {
    expect(isTransientAiError(new Error("some unrelated failure"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeAgentTurn
// ---------------------------------------------------------------------------

describe("executeAgentTurn", () => {
  it("happy path: appends user + assistant messages and completes a task", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("Hello!") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, fakeModels(model))
    );

    // finished() always fires
    expect(bus.finished).toHaveBeenCalledTimes(1);
    // The task exists before its terminal response, allowing async acceptance.
    expect(bus.published).toHaveLength(2);
    const terminal = expectTerminalReply(bus);
    expect(terminal?.messageId).toBe("m1:final");
    expect(partsText(terminal?.parts)).toBe("Hello!");
    // User turn then assistant turn persisted
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("persists the incoming turn text verbatim (Gateway owns wrapping)", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("ok") as never
    });
    const bus = fakeEventBus();

    // In production this arrives already wrapped by the Gateway; the loop must
    // store it untouched, not re-wrap it.
    const wrapped =
      '<turn from="Grace" id="U2" channel="general" ' +
      'at="2026-06-25T14:30:00.000Z">register a bot</turn>';

    await executeAgentTurn(
      fakeRequestContext(wrapped),
      bus.eventBus,
      makeCfg(session, fakeModels(model))
    );

    const userTurn = session.messages.find((m) => m.role === "user");
    expect(userTurn?.parts[0]).toMatchObject({ type: "text", text: wrapped });
  });

  it("falls back to the fallback model when the primary throws", async () => {
    const session = new FakeSession();
    const fallbackModel = new MockLanguageModelV3({
      doGenerate: async () => okResult("Fallback reply") as never
    });
    const bus = fakeEventBus();

    // Make primary() itself throw synchronously — exercises the inner catch that
    // retries with fallback() without passing a throwing model to generateText
    // (which would leak an unhandled rejection through the SDK telemetry span).
    const models: ModelPair = {
      primary: () => {
        throw new Error("primary unavailable");
      },
      fallback: () => fallbackModel,
      primaryId: () => "primary-model",
      fallbackId: () => "fallback-model"
    };

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, models)
    );

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(partsText(expectTerminalReply(bus)?.parts)).toBe("Fallback reply");
  });

  it("publishes the transient reply when a transient error propagates to the outer catch", async () => {
    // Inject the transient error through prepare() to test the outer catch's
    // isTransientAiError branch without invoking generateText (which leaks
    // unhandled rejections through the telemetry span in the Workers runtime).
    const bus = fakeEventBus();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("unused") as never
    });

    await executeAgentTurn(fakeRequestContext("hi"), bus.eventBus, {
      models: fakeModels(model),
      prepare: async () => {
        throw new Error("capacity temporarily exceeded");
      },
      unexpectedReply: "Something went wrong. Please try again."
    });

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(bus.published).toHaveLength(2);
    expect(partsText(expectTerminalReply(bus)?.parts)).toMatch(
      /temporarily unavailable/i
    );
  });

  it("publishes unexpectedReply when a non-transient error propagates to the outer catch", async () => {
    // Same injection strategy as the transient test above — prepare() throw
    // exercises the same outer-catch branch, just the non-transient arm.
    const bus = fakeEventBus();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("unused") as never
    });

    await executeAgentTurn(fakeRequestContext("hi"), bus.eventBus, {
      models: fakeModels(model),
      prepare: async () => {
        throw new Error("some unexpected failure");
      },
      unexpectedReply: "Something went wrong. Please try again."
    });

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(bus.published).toHaveLength(2);
    // `failed`, not `completed`: A2A v1.0 has no structured task error, so the
    // state is the only thing that tells the gateway this turn broke.
    expect(
      partsText(expectTerminalReply(bus, TaskState.TASK_STATE_FAILED)?.parts)
    ).toBe("Something went wrong. Please try again.");
  });

  it("publishes the transient reply and skips persist when model returns empty text", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("   ") as never // whitespace-only → trims to ""
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, fakeModels(model))
    );

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(partsText(expectTerminalReply(bus)?.parts)).toMatch(
      /temporarily unavailable/i
    );
    // User message WAS appended; assistant message was NOT (empty reply skipped)
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("publishes the transient reply and skips persist when finish_reason is 'length'", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => lengthResult("truncated content here") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, fakeModels(model))
    );

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(partsText(expectTerminalReply(bus)?.parts)).toMatch(
      /temporarily unavailable/i
    );
    // Assistant message must NOT be persisted when the reply was truncated
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("publishes unexpectedReply and still finishes when prepare() throws", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("unused") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(fakeRequestContext(), bus.eventBus, {
      models: fakeModels(model),
      prepare: async () => {
        throw new Error("missing metadata");
      },
      unexpectedReply: "Something went wrong. Please try again."
    });

    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(bus.published).toHaveLength(2);
    expect(
      partsText(expectTerminalReply(bus, TaskState.TASK_STATE_FAILED)?.parts)
    ).toBe("Something went wrong. Please try again.");
  });

  it("always calls finished() even when the second appendMessage throws", async () => {
    const session = new FakeSession();
    // Let the first appendMessage (user turn) succeed, fail on the second (assistant turn).
    session.appendSpy
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("SQL error"));

    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("Hi") as never
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext(),
      bus.eventBus,
      makeCfg(session, fakeModels(model))
    );

    expect(bus.finished).toHaveBeenCalledTimes(1);
  });

  it("publishes textual tool-loop steps without persisting them", async () => {
    const session = new FakeSession();
    let generation = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        if (generation++ === 0) {
          return {
            ...toolCallResult("lookup", {}),
            content: [
              { type: "text", text: "I will check that." },
              {
                type: "tool-call",
                toolCallId: "tc1",
                toolName: "lookup",
                input: "{}"
              }
            ]
          } as never;
        }
        return okResult("Here is what I found.") as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, fakeModels(model), {
        prepare: async () => ({
          session,
          systemSuffix: "",
          tools: {
            lookup: tool({
              description: "Lookup a value.",
              inputSchema: z.object({}),
              execute: async () => "found"
            })
          }
        })
      })
    );

    expect(bus.published).toHaveLength(3);
    expect(statusEventAt(bus, 1)).toMatchObject({
      taskId: "task-1",
      status: {
        state: TaskState.TASK_STATE_WORKING,
        message: { messageId: "m1:step:0" }
      }
    });
    expect(partsText(statusEventAt(bus, 1).status?.message?.parts)).toBe(
      "I will check that."
    );
    expect(expectTerminalReply(bus)?.parts[0]).toMatchObject({
      content: { $case: "text", value: "Here is what I found." }
    });
    expect(session.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    expect(session.messages[1].parts[0]).toMatchObject({
      type: "text",
      text: "Here is what I found."
    });
  });

  it("does not double-post the final text when generation stops at the step limit", async () => {
    const session = new FakeSession();
    // Every step emits text + a tool call, so the loop never reaches a plain
    // stop and instead halts at the step limit. The final step's text is both
    // streamed non-terminally (`:step:N`) and returned as `result.text`.
    let n = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        const i = n++;
        return {
          ...toolCallResult("lookup", {}),
          content: [
            { type: "text", text: `step-${i}` },
            {
              type: "tool-call",
              toolCallId: `tc${i}`,
              toolName: "lookup",
              input: "{}"
            }
          ]
        } as never;
      }
    });
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("hi"),
      bus.eventBus,
      makeCfg(session, fakeModels(model), {
        prepare: async () => ({
          session,
          systemSuffix: "",
          tools: {
            lookup: tool({
              description: "Lookup a value.",
              inputSchema: z.object({}),
              execute: async () => "found"
            })
          }
        })
      })
    );

    // The final step's text was streamed as a non-terminal update; the terminal
    // event completes the task with empty text so it isn't posted twice.
    const stepTexts = bus.published.flatMap((e) =>
      e.kind === "statusUpdate" &&
      e.data.status?.state === TaskState.TASK_STATE_WORKING
        ? [partsText(e.data.status.message?.parts)]
        : []
    );
    const lastStepText = stepTexts.at(-1);
    expect(lastStepText).toBeTruthy();

    const terminal = expectTerminalReply(bus);
    expect(partsText(terminal?.parts)).toBe("");

    // The final text appears exactly once across every published event…
    const allTexts = bus.published.map((e) =>
      e.kind === "statusUpdate" ? partsText(e.data.status?.message?.parts) : ""
    );
    expect(allTexts.filter((t) => t === lastStepText)).toHaveLength(1);
    // …yet the full reply is still persisted to session history.
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1].parts[0]).toMatchObject({
      type: "text",
      text: lastStepText
    });
  });
});

// ---------------------------------------------------------------------------
// Cancellation (🛑 recorded on the task row, read back between steps)
// ---------------------------------------------------------------------------

describe("executeAgentTurn — cancellation", () => {
  /** A tool-calling first step, then a final answer — i.e. a two-step turn. */
  function toolLoopModel(onGeneration: (n: number) => void) {
    let generation = 0;
    return new MockLanguageModelV3({
      doGenerate: async () => {
        onGeneration(generation);
        return (
          generation++ === 0
            ? toolCallResult("work", {})
            : okResult("Here is the answer.")
        ) as never;
      }
    });
  }

  function runTurn(
    session: SessionLike,
    model: LanguageModel,
    isCanceled?: AgentTurnConfig["isCanceled"]
  ) {
    const bus = fakeEventBus();
    const done = executeAgentTurn(
      fakeRequestContext("do some work"),
      bus.eventBus,
      makeCfg(session, fakeModels(model), {
        isCanceled,
        prepare: async () => ({
          session,
          systemSuffix: "",
          tools: {
            work: tool({
              description: "Do some work.",
              inputSchema: z.object({}),
              execute: async () => "done"
            })
          }
        })
      })
    );
    return { bus, done };
  }

  it("stops before the next step once a 🛑 is recorded", async () => {
    const generations: number[] = [];
    const session = new FakeSession();
    const { bus, done } = runTurn(
      session,
      toolLoopModel((n) => generations.push(n)),
      async () => true
    );
    await done;

    // The second model call — the one that would have produced the answer — is
    // never made. That is the work the stop actually saves.
    expect(generations).toEqual([0]);
    expect(statusEventAt(bus, -1)).toMatchObject({
      status: { state: TaskState.TASK_STATE_CANCELED }
    });
    // Empty: the gateway posts its own "🛑 Stopped." notice.
    expect(partsText(statusEventAt(bus, -1).status?.message?.parts)).toBe("");
    expect(bus.finished).toHaveBeenCalledTimes(1);
  });

  it("is keyed by the dispatch token so it reads its own row", async () => {
    const seen: string[] = [];
    const { done } = runTurn(
      new FakeSession(),
      toolLoopModel(() => {}),
      async (token) => {
        seen.push(token);
        return true;
      }
    );
    await done;

    // `m1` is the messageId on the request context — the same value the gateway
    // uses as the task row's token.
    expect(seen).toEqual(["m1"]);
  });

  it("records the stop in history so the next turn doesn't redo the work", async () => {
    const session = new FakeSession();
    const { done } = runTurn(
      session,
      toolLoopModel(() => {}),
      async () => true
    );
    await done;

    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1].parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("stopped by the user")
    });
  });

  it("runs to completion when no stop is recorded", async () => {
    const generations: number[] = [];
    const session = new FakeSession();
    const { bus, done } = runTurn(
      session,
      toolLoopModel((n) => generations.push(n)),
      async () => false
    );
    await done;

    expect(generations).toEqual([0, 1]);
    expect(partsText(expectTerminalReply(bus)?.parts)).toBe(
      "Here is the answer."
    );
  });

  it("keeps going when the stop check itself fails", async () => {
    // The check reads D1 mid-turn. A blip there must not destroy a turn nobody
    // asked to stop.
    const session = new FakeSession();
    const { bus, done } = runTurn(
      session,
      toolLoopModel(() => {}),
      async () => {
        throw new Error("d1 unavailable");
      }
    );
    await done;

    expect(partsText(expectTerminalReply(bus)?.parts)).toBe(
      "Here is the answer."
    );
  });

  it("withholds the answer of a single-step turn that was stopped", async () => {
    // A one-call turn has no step boundary to be interrupted at, so the work runs
    // to completion — but the reply must not reach Slack after the user was told
    // "🛑 Stopped." The post-generation check is what withholds it.
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("answered in one shot") as never
    });
    const { bus, done } = runTurn(session, model, async () => true);
    await done;

    expect(statusEventAt(bus, -1)).toMatchObject({
      status: { state: TaskState.TASK_STATE_CANCELED }
    });
    expect(publishedText(bus)).not.toContain("answered in one shot");
    // The compute was spent, so history records the reply was abandoned, not given.
    expect(session.messages[1]?.parts[0]).toMatchObject({
      text: expect.stringContaining("stopped by the user")
    });
  });

  it("checks once more after generation, not only between steps", async () => {
    // Simulates a 🛑 landing while the final model call was in flight: no boundary
    // is left, so only the post-generation check can catch it.
    let stopped = false;
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        stopped = true; // the stop lands during this call
        return okResult("too late to be useful") as never;
      }
    });
    const { bus, done } = runTurn(session, model, async () => stopped);
    await done;

    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_CANCELED);
  });
});

// ---------------------------------------------------------------------------
// Human-in-the-loop park (a tool calls turn.park → end in input-required)
// ---------------------------------------------------------------------------

describe("executeAgentTurn — HITL park", () => {
  const request = {
    type: "io.looping.hitl.request",
    requestId: "req-1",
    requestKind: "choice",
    prompt: "Which environment?",
    options: [{ id: "opt_0", label: "dev" }],
    allowFreeform: true
  };

  /** A model that calls `ask` on its first step; a second step would answer. */
  function askThenAnswerModel(onGeneration: () => void) {
    let n = 0;
    return new MockLanguageModelV3({
      doGenerate: async () => {
        onGeneration();
        return (
          n++ === 0 ? toolCallResult("ask", {}) : okResult("unreachable")
        ) as never;
      }
    });
  }

  it("ends the turn in input-required with the request DataPart, no terminal reply", async () => {
    const session = new FakeSession();
    let generations = 0;
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("set up an agent"),
      bus.eventBus,
      makeCfg(session, fakeModels(askThenAnswerModel(() => generations++)), {
        prepare: async (_t, _m, turn) => ({
          session,
          systemSuffix: "",
          tools: {
            ask: tool({
              description: "Ask the user.",
              inputSchema: z.object({}),
              execute: async () => {
                turn.park(request as never);
                return { status: "awaiting_user" };
              }
            })
          }
        })
      })
    );

    // The turn always finishes, but the model's second (answering) step never runs.
    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(generations).toBe(1);

    // Terminal event is input-required (an interrupted, non-terminal task
    // state) carrying the HITL data part.
    const last = statusEventAt(bus, -1);
    expect(last).toMatchObject({
      taskId: "task-1",
      status: {
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        message: { messageId: "m1:hitl" }
      }
    });
    const parts = last.status?.message?.parts ?? [];
    expect(partsText(parts)).toBe("Which environment?");
    expect(
      parts.some((p) => {
        const data = dataOf(p) as
          { type?: string; requestId?: string } | undefined;
        return (
          data?.type === "io.looping.hitl.request" && data.requestId === "req-1"
        );
      })
    ).toBe(true);

    // No completed/canceled terminal was published.
    const states = publishedStates(bus);
    expect(states).not.toContain(TaskState.TASK_STATE_COMPLETED);
    expect(states).not.toContain(TaskState.TASK_STATE_CANCELED);

    // The prompt is persisted as the assistant turn so the resumed turn has context.
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1].parts[0]).toMatchObject({
      type: "text",
      text: "Which environment?"
    });
  });

  it("a recorded 🛑 wins over a park (no prompt is raised)", async () => {
    const session = new FakeSession();
    const bus = fakeEventBus();

    await executeAgentTurn(
      fakeRequestContext("set up an agent"),
      bus.eventBus,
      makeCfg(session, fakeModels(askThenAnswerModel(() => {})), {
        isCanceled: async () => true,
        prepare: async (_t, _m, turn) => ({
          session,
          systemSuffix: "",
          tools: {
            ask: tool({
              description: "Ask the user.",
              inputSchema: z.object({}),
              execute: async () => {
                turn.park(request as never);
                return { status: "awaiting_user" };
              }
            })
          }
        })
      })
    );

    expect(publishedStates(bus).at(-1)).toBe(TaskState.TASK_STATE_CANCELED);
    expect(publishedStates(bus)).not.toContain(
      TaskState.TASK_STATE_INPUT_REQUIRED
    );
  });
});
