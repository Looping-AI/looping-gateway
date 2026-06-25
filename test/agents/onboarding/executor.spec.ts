import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { MockLanguageModelV3 } from "ai/test";
import type { SessionMessage } from "agents/experimental/memory/session";
import { OnboardingAgentExecutor } from "@/agents/onboarding/executor";
import { slackTsToIso } from "@/agents/shared/messages";
import type { SessionHost, SessionLike } from "@/agents/shared/session";
import type { UserAuthContext } from "@/auth";

const sqlHost: SessionHost = { sql: () => [] };

const caller: UserAuthContext = {
  slackUserId: "U_onb",
  displayName: "Newbie",
  isPrimaryOwner: false,
  isOrgAdmin: false,
  adminWorkspaces: []
};

class FakeSession implements SessionLike {
  messages: SessionMessage[] = [];
  constructor(private compactions: unknown[] = []) {}
  async appendMessage(m: SessionMessage) {
    this.messages.push(m);
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

/** Spread real env but replace AI + VECTORIZE with spies (no network needed). */
function fakeRecallEnv() {
  const run = vi.fn(async () => ({ data: [Array(1024).fill(0.1)] }));
  const query = vi.fn(async (_vector: number[], _opts: unknown) => ({
    count: 0,
    matches: []
  }));
  return {
    env: { ...env, AI: { run }, VECTORIZE: { query } } as unknown as Env,
    run,
    query
  };
}

function toolCallResult(toolName: string, input: unknown) {
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

function makeRequest() {
  const published: Array<{ parts: Array<{ text?: string }> }> = [];
  let finished = false;
  const eventBus = {
    publish: (e: unknown) => published.push(e as never),
    finished: () => {
      finished = true;
    }
  };
  const requestContext = {
    contextId: "D_ONB:thread-1",
    userMessage: {
      kind: "message",
      messageId: "m1",
      role: "user",
      parts: [{ kind: "text", text: "how does Looping work?" }],
      metadata: {
        user: caller,
        agentKind: "onboarding",
        messageTs: "1700000000.000300",
        channelName: null
      }
    }
  };
  return {
    published,
    isFinished: () => finished,
    // Cast at the boundary — we only exercise the fields the executor reads.
    eventBus: eventBus as never,
    requestContext: requestContext as never
  };
}

// Minimal valid LanguageModelV3 generate result.
function okResult(text: string) {
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

describe("OnboardingAgentExecutor", () => {
  it("runs the loop and publishes the model's reply", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        okResult("Looping routes work through Slack.") as never
    });
    const exec = new OnboardingAgentExecutor(sqlHost, env, {
      model,
      createSession: () => session
    });

    const t = makeRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(t.published).toHaveLength(1);
    expect(t.published[0].parts[0].text).toBe(
      "Looping routes work through Slack."
    );
    // user turn + assistant turn persisted
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("attributes the user turn with who/where/when (uniform with admin)", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("ok") as never
    });
    const exec = new OnboardingAgentExecutor(sqlHost, env, {
      model,
      createSession: () => session
    });

    const t = makeRequest();
    await exec.execute(t.requestContext, t.eventBus);

    const userTurn = session.messages.find((m) => m.role === "user");
    // Single-actor DM: author present; channel falls back to the contextId's
    // channel id since a DM has no resolved name.
    expect(userTurn?.parts[0]).toMatchObject({
      type: "text",
      text:
        `<turn from="Newbie" id="U_onb" channel="D_ONB" ` +
        `at="${slackTsToIso("1700000000.000300")}">how does Looping work?</turn>`
    });
  });

  it("publishes a friendly error and still finishes when the loop throws", async () => {
    class ThrowingSession extends FakeSession {
      async refreshSystemPrompt(): Promise<string> {
        throw new Error("memory boom");
      }
    }
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("unused") as never
    });
    const exec = new OnboardingAgentExecutor(sqlHost, env, {
      model,
      createSession: () => new ThrowingSession()
    });

    const t = makeRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(t.published).toHaveLength(1);
    expect(t.published[0].parts[0].text?.toLowerCase()).toContain("error");
  });

  it("offers recall and routes it through the user namespace", async () => {
    const session = new FakeSession([{ id: "c1" }]); // hasArchive=true
    const { env: fenv, query } = fakeRecallEnv();
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        (call++ === 0
          ? toolCallResult("recall", { query: "what did I set up before?" })
          : okResult("Found it in past context.")) as never
    });
    const exec = new OnboardingAgentExecutor(sqlHost, fenv, {
      model,
      createSession: () => session
    });

    const t = makeRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(t.published).toHaveLength(1);
    // Recall must be scoped to the caller's user namespace.
    expect(query).toHaveBeenCalledTimes(1);
    const opts = query.mock.calls[0][1] as { namespace: string };
    expect(opts.namespace).toBe("onboarding:U_onb");
  });

  it("errors at the boundary when caller context is absent (no null path)", async () => {
    const session = new FakeSession([{ id: "c1" }]);
    let modelCalled = false;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        modelCalled = true;
        return okResult("unused") as never;
      }
    });
    const exec = new OnboardingAgentExecutor(sqlHost, env, {
      model,
      createSession: () => session
    });

    // Request without a user — the Slack user is now a required precondition
    // (uniform with admin), so prepare throws and the loop publishes the
    // friendly error rather than running a degraded, null-tolerant turn.
    const requestContext = {
      contextId: "D_ONB:no-user",
      userMessage: {
        kind: "message",
        messageId: "m_nouser",
        role: "user",
        parts: [{ kind: "text", text: "hello" }],
        metadata: { agentKind: "onboarding" } // no user field
      }
    };
    const published: Array<{ parts: Array<{ text?: string }> }> = [];
    let finished = false;
    const eventBus = {
      publish: (e: unknown) => published.push(e as never),
      finished: () => {
        finished = true;
      }
    };

    await exec.execute(requestContext as never, eventBus as never);

    expect(finished).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0].parts[0].text?.toLowerCase()).toContain("error");
    expect(modelCalled).toBe(false);
  });
});
