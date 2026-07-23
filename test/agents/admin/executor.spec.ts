import { describe, it, expect, afterEach, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { AdminAgentExecutor, type SessionHost } from "@/agents/admin/executor";
import type { UserAuthContext } from "@/auth";
import type { Message } from "@a2a-js/sdk";
import {
  buildHitlResponseParts,
  HITL_APPROVE_OPTION_ID,
  HITL_REJECT_OPTION_ID
} from "@/a2a/hitl";
import type { GatedAction } from "@/agents/admin/approvals";
import { getAgent, registerAgent } from "@/db/models/agents";
import {
  FakeSession,
  fakeRecallEnv,
  okResult,
  toolCallResult,
  makeRequest,
  terminalTaskText
} from "../../helpers/agents";
import { freshWsId } from "../../helpers/workspace";

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

describe("AdminAgentExecutor — HITL approval resume", () => {
  /** A Map-backed pending-action store (mirrors the DO-storage seams). */
  function fakeStore(seed: Record<string, GatedAction> = {}) {
    const map = new Map<string, GatedAction>(Object.entries(seed));
    return {
      map,
      storePendingAction: async (id: string, action: GatedAction) => {
        map.set(id, action);
      },
      takePendingAction: async (id: string) => {
        const action = map.get(id) ?? null;
        map.delete(id);
        return action;
      }
    };
  }

  /** A resume request carrying `parts` (a HITL response DataPart) as the user turn. */
  function resumeRequest(parts: Message["parts"], wsId: number) {
    const published: Array<{
      status?: {
        state?: string;
        message?: { parts?: Array<{ text?: string }> };
      };
    }> = [];
    let finished = false;
    const eventBus = {
      publish: (e: unknown) => published.push(e as never),
      finished: () => {
        finished = true;
      }
    };
    const requestContext = {
      contextId: "C_ADMIN:thread-1",
      taskId: "task-test",
      userMessage: {
        kind: "message",
        messageId: "r1",
        role: "user",
        parts,
        metadata: {
          user: { ...caller, adminWorkspaces: [wsId] },
          agentKind: "admin",
          adminWorkspaceId: wsId
        }
      }
    };
    return {
      published,
      isFinished: () => finished,
      eventBus: eventBus as never,
      requestContext: requestContext as never
    };
  }

  it("runs the destructive action when the user approves", async () => {
    const wsId = await freshWsId("resume-approve");
    await registerAgent({
      name: "resume-del",
      kind: "custom",
      displayName: "Resume Del",
      a2aEndpoint: "https://example.com/resume-del",
      notifyOn: "mention",
      workspaceId: wsId
    });
    const store = fakeStore({
      "req-1": { kind: "unregister_agent", name: "resume-del", wsId }
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("Done — I deleted it.") as never
    });
    const exec = new AdminAgentExecutor(sqlHost, {
      model,
      createSession: () => new FakeSession(),
      ...store
    });

    const t = resumeRequest(
      buildHitlResponseParts({
        requestId: "req-1",
        optionId: HITL_APPROVE_OPTION_ID,
        answeredBy: "U1",
        humanText: "Approve"
      }),
      wsId
    );
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(await getAgent("resume-del")).toBeNull();
    expect(store.map.has("req-1")).toBe(false); // consumed at most once
    expect(terminalTaskText(t.published)).toBe("Done — I deleted it.");
  });

  it("does not run the action when the user rejects", async () => {
    const wsId = await freshWsId("resume-reject");
    await registerAgent({
      name: "resume-keep",
      kind: "custom",
      displayName: "Resume Keep",
      a2aEndpoint: "https://example.com/resume-keep",
      notifyOn: "mention",
      workspaceId: wsId
    });
    const store = fakeStore({
      "req-2": { kind: "unregister_agent", name: "resume-keep", wsId }
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("Okay, I won't delete it.") as never
    });
    const exec = new AdminAgentExecutor(sqlHost, {
      model,
      createSession: () => new FakeSession(),
      ...store
    });

    const t = resumeRequest(
      buildHitlResponseParts({
        requestId: "req-2",
        optionId: HITL_REJECT_OPTION_ID,
        answeredBy: "U1",
        humanText: "Reject"
      }),
      wsId
    );
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(await getAgent("resume-keep")).not.toBeNull();
  });

  it("treats an answer with no pending action as a normal turn (ask_user)", async () => {
    const store = fakeStore(); // empty — an ask_user answer has no stored action
    const session = new FakeSession();
    const model = new MockLanguageModelV3({
      doGenerate: async () => okResult("Great, using staging.") as never
    });
    const exec = new AdminAgentExecutor(sqlHost, {
      model,
      createSession: () => session,
      ...store
    });

    const t = resumeRequest(
      buildHitlResponseParts({
        requestId: "no-such-req",
        optionId: "opt_1",
        answeredBy: "U1",
        humanText: "staging"
      }),
      0
    );
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(terminalTaskText(t.published)).toBe("Great, using staging.");
    // The human's chosen label flows in as the user turn the model continues from.
    expect(session.messages[0].parts[0]).toMatchObject({ text: "staging" });
  });
});
