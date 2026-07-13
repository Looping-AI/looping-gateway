import { describe, it, expect, afterEach, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { AdminAgentExecutor, type SessionHost } from "@/agents/admin/executor";
import type { UserAuthContext } from "@/auth";
import {
  FakeSession,
  fakeRecallEnv,
  okResult,
  toolCallResult,
  makeRequest,
  terminalTaskText
} from "../../helpers/agents";

const sqlHost: SessionHost = { sql: () => [] };

const caller: UserAuthContext = {
  slackUserId: "U1",
  displayName: "Tester",
  isPrimaryOwner: false,
  isOrgAdmin: true,
  adminWorkspaces: []
};

const adminRequest = () =>
  makeRequest({
    contextId: "C_ADMIN:thread-1",
    text: "list agents",
    metadata: { user: caller, agentKind: "admin", adminWorkspaceId: 0 }
  });

afterEach(() => vi.restoreAllMocks());

describe("AdminAgentExecutor", () => {
  it("runs the loop and completes an A2A task with the model's reply", async () => {
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("Here are your agents.") as never
    });
    const exec = new AdminAgentExecutor(sqlHost, {
      model,
      createSession: () => session
    });

    const t = adminRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(t.published).toHaveLength(2);
    expect(terminalTaskText(t.published)).toBe("Here are your agents.");
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
    const exec = new AdminAgentExecutor(sqlHost, {
      model,
      createSession: () => new ThrowingSession()
    });

    const t = adminRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(t.published).toHaveLength(2);
    expect(terminalTaskText(t.published)?.toLowerCase()).toContain("error");
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
    const exec = new AdminAgentExecutor(sqlHost, {
      model,
      createSession: () => session
    });

    const t = adminRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(capturedToolNames).not.toContain("recall");
  });

  it("offers recall and routes it through the workspace namespace", async () => {
    const session = new FakeSession([{ id: "c1" }]); // hasArchive=true
    const { query } = fakeRecallEnv();
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        (call++ === 0
          ? toolCallResult("recall", {
              query: "what did we decide last month?"
            })
          : okResult("Found it in past context.")) as never
    });
    const exec = new AdminAgentExecutor(sqlHost, {
      model,
      createSession: () => session
    });

    const t = adminRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(t.published).toHaveLength(2);
    // The recall tool must have been executed against the workspace namespace.
    expect(query).toHaveBeenCalledTimes(1);
    const opts = query.mock.calls[0][1] as { namespace: string };
    expect(opts.namespace).toBe("admin:0");
  });
});
