import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { MockLanguageModelV3 } from "ai/test";
import type { SessionMessage } from "agents/experimental/memory/session";
import {
  AdminAgentExecutor,
  type SessionHost,
  type SessionLike
} from "@/agents/admin/executor";
import type { UserAuthContext } from "@/auth";

const sqlHost: SessionHost = { sql: () => [] };

const caller: UserAuthContext = {
  slackUserId: "U1",
  displayName: "Tester",
  isPrimaryOwner: false,
  isOrgAdmin: true,
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
    contextId: "C_ADMIN:thread-1",
    userMessage: {
      kind: "message",
      messageId: "m1",
      role: "user",
      parts: [{ kind: "text", text: "list agents" }],
      metadata: {
        user: caller,
        agentKind: "admin",
        adminWorkspaceId: 0
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

describe("AdminAgentExecutor", () => {
  it("runs the loop and publishes the model's reply", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("Here are your agents.") as never
    });
    const exec = new AdminAgentExecutor(sqlHost, env, {
      model,
      createSession: () => session
    });

    const t = makeRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(t.published).toHaveLength(1);
    expect(t.published[0].parts[0].text).toBe("Here are your agents.");
    // user turn + assistant turn persisted
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("publishes a friendly error and still finishes when the loop throws", async () => {
    // A session whose history read fails exercises the executor's catch path
    // without invoking the model (and its telemetry internals).
    class ThrowingSession extends FakeSession {
      async refreshSystemPrompt(): Promise<string> {
        throw new Error("memory boom");
      }
    }
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("unused") as never
    });
    const exec = new AdminAgentExecutor(sqlHost, env, {
      model,
      createSession: () => new ThrowingSession()
    });

    const t = makeRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(t.published).toHaveLength(1);
    expect(t.published[0].parts[0].text?.toLowerCase()).toContain("error");
  });

  it("withholds the recall tool before the first compaction", async () => {
    const session = new FakeSession([]); // no compactions → hasArchive=false
    let capturedToolNames: string[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        capturedToolNames = (options.tools ?? []).map((t) => t.name);
        return okResult("done") as never;
      }
    });
    const exec = new AdminAgentExecutor(sqlHost, env, {
      model,
      createSession: () => session
    });

    const t = makeRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(capturedToolNames).not.toContain("recall");
  });

  it("offers recall and routes it through the workspace namespace", async () => {
    const session = new FakeSession([{ id: "c1" }]); // hasArchive=true
    const { env: fenv, query } = fakeRecallEnv();
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        (call++ === 0
          ? toolCallResult("recall", {
              query: "what did we decide last month?"
            })
          : okResult("Found it in past context.")) as never
    });
    const exec = new AdminAgentExecutor(sqlHost, fenv, {
      model,
      createSession: () => session
    });

    const t = makeRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(t.published).toHaveLength(1);
    // The recall tool must have been executed against the workspace namespace.
    expect(query).toHaveBeenCalledTimes(1);
    const opts = query.mock.calls[0][1] as { namespace: string };
    expect(opts.namespace).toBe("admin:0");
  });
});
