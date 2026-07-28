import { vi } from "vitest";
import { env } from "cloudflare:workers";
import type { SessionMessage } from "agents/experimental/memory/session";
import type { AgentExecutionEvent } from "@a2a-js/sdk/server";
import type { TaskState } from "@a2a-js/sdk";
import { partsText } from "@/a2a/parts";
import { EMBED_MODEL_ID } from "@/config";
import type { SessionLike } from "@/agents/shared/session";
import { userMessage } from "./a2a";

/**
 * In-memory `SessionLike` for driving agent executors without a Durable Object.
 * `appendSpy` lets tests assert on persisted messages; `compactions` seeds
 * `getCompactions` (non-empty ⇒ the executor treats an episodic archive as present).
 */
export class FakeSession implements SessionLike {
  messages: SessionMessage[] = [];
  appendSpy = vi.fn(async (m: SessionMessage) => {
    this.messages.push(m);
  });
  constructor(private compactions: unknown[] = []) {}
  async appendMessage(m: SessionMessage) {
    return this.appendSpy(m);
  }
  async getHistory() {
    return this.messages;
  }
  async refreshSystemPrompt() {
    return "SYSTEM PROMPT";
  }
  async tools() {
    return {};
  }
  async getCompactions() {
    return this.compactions;
  }
}

/**
 * Spy on the global `env` AI + VECTORIZE bindings (no network needed). Recall
 * code reads them off `cloudflare:workers`, so tests stub the real bindings.
 * Restore with `vi.restoreAllMocks()` in an `afterEach`.
 */
export function fakeRecallEnv() {
  const run = vi.spyOn(env.AI, "run").mockImplementation((async () => ({
    data: [Array(1024).fill(0.1)]
  })) as never);
  const query = vi
    .spyOn(env.VECTORIZE, "query")
    .mockImplementation((async () => ({ count: 0, matches: [] })) as never);
  return { run, query };
}

/**
 * Stub the whole `AI` binding so a built-in agent's turn completes offline.
 *
 * `remoteBindings: false` (vitest.config.ts) makes the real binding throw
 * "Binding AI needs to be run remotely". Specs that only trigger an agent turn
 * as a *side effect* — a Slack event that wakes the admin/onboarding DO — never
 * await that turn, so the failure escapes on the DO's detached promise and
 * vitest reports it as an unhandled rejection. Chat calls answer with `text`,
 * embedding calls with one filler vector per input. Restore with
 * `vi.restoreAllMocks()`.
 */
export function stubAgentAi(text = "stubbed agent reply") {
  return vi
    .spyOn(env.AI, "run")
    .mockImplementation((async (model: string, inputs: { text?: string[] }) =>
      model === EMBED_MODEL_ID
        ? { data: (inputs.text ?? [""]).map(() => Array(1024).fill(0.1)) }
        : { response: text }) as never);
}

// Minimal valid LanguageModelV3 generate result.
export function okResult(text: string) {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop" },
    usage: {
      inputTokens: { total: 1, noCache: 1 },
      outputTokens: { total: 1 },
      totalTokens: 2
    },
    warnings: []
  };
}

/** Like `okResult` but signals the model hit its output-length cap. */
export function lengthResult(text: string) {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "length" },
    usage: {
      inputTokens: { total: 1, noCache: 1 },
      outputTokens: { total: 1 },
      totalTokens: 2
    },
    warnings: []
  };
}

export function toolCallResult(toolName: string, input: unknown) {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: "tc1",
        toolName,
        input: JSON.stringify(input)
      }
    ],
    finishReason: { unified: "tool-calls" },
    usage: {
      inputTokens: { total: 1, noCache: 1 },
      outputTokens: { total: 1 },
      totalTokens: 2
    },
    warnings: []
  };
}

/** Extract text from the terminal A2A task-status event captured by a test bus. */
export function terminalTaskText(
  events: AgentExecutionEvent[]
): string | undefined {
  const event = events.at(-1);
  if (event?.kind !== "statusUpdate") return undefined;
  return partsText(event.data.status?.message?.parts);
}

/**
 * The terminal A2A state a test bus captured. A2A v1.0 carries no structured
 * task error, so this state is the only machine-readable signal that a turn
 * failed — assert on it rather than on wording in the reply.
 */
export function terminalTaskState(
  events: AgentExecutionEvent[]
): TaskState | undefined {
  const event = events.at(-1);
  if (event?.kind !== "statusUpdate") return undefined;
  return event.data.status?.state;
}

/** A one-turn agent request plus a capturing event bus, shared by executor specs. */
export function makeRequest(opts: {
  contextId: string;
  text: string;
  metadata: Record<string, unknown>;
}) {
  const published: AgentExecutionEvent[] = [];
  let finished = false;
  const eventBus = {
    publish: (e: unknown) => published.push(e as never),
    finished: () => {
      finished = true;
    }
  };
  const requestContext = {
    contextId: opts.contextId,
    taskId: "task-test",
    userMessage: userMessage(opts.text, {
      contextId: opts.contextId,
      metadata: opts.metadata
    })
  };
  return {
    published,
    isFinished: () => finished,
    // Cast at the boundary — we only exercise the fields the executor reads.
    eventBus: eventBus as never,
    requestContext: requestContext as never
  };
}
