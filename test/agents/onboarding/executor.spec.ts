import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { MockLanguageModelV3 } from "ai/test";
import { OnboardingAgentExecutor } from "@/agents/onboarding/executor";
import type { SessionHost } from "@/agents/shared/session";
import type { UserAuthContext } from "@/auth";
import {
  FakeSession,
  fakeRecallEnv,
  okResult,
  toolCallResult,
  makeRequest
} from "../../helpers/agents";

const sqlHost: SessionHost = { sql: () => [] };

const caller: UserAuthContext = {
  slackUserId: "U_onb",
  displayName: "Newbie",
  isPrimaryOwner: false,
  isOrgAdmin: false,
  adminWorkspaces: []
};

const onboardingRequest = () =>
  makeRequest({
    contextId: "D_ONB:thread-1",
    text: "how does Looping work?",
    metadata: { user: caller, agentKind: "onboarding" }
  });

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

    const t = onboardingRequest();
    await exec.execute(t.requestContext, t.eventBus);

    expect(t.isFinished()).toBe(true);
    expect(t.published).toHaveLength(1);
    expect(t.published[0].parts[0].text).toBe(
      "Looping routes work through Slack."
    );
    // user turn + assistant turn persisted
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
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

    const t = onboardingRequest();
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

    const t = onboardingRequest();
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
