import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { MockLanguageModelV3 } from "ai/test";
import type { SessionMessage } from "agents/experimental/memory/session";
import { OnboardingAgentExecutor } from "@/agents/onboarding/executor";
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
        agentKind: "onboarding"
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
});
