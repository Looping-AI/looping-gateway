import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { dispatchToAgent } from "@/agents/dispatch";

// End-to-end of the local A2A path: client (official SDK) → DO stub.fetch →
// serveA2A → DefaultRequestHandler → EchoExecutor → reply, all in-process.
describe("dispatchToAgent (local Durable Object)", () => {
  it("echoes via the AdminAgent A2A server", async () => {
    const reply = await dispatchToAgent(
      env,
      { name: "admin", kind: "admin", a2aEndpoint: null },
      {
        text: "ping",
        contextId: "C1:1.1",
        metadata: {
          user: null,
          channelId: "C1",
          workspaceId: 0,
          slackTeamId: "T1",
          eventId: "E1"
        }
      }
    );
    expect(reply).toBe("You said: ping");
  });

  it("routes the onboarding kind to the OnboardingAgent", async () => {
    const reply = await dispatchToAgent(
      env,
      { name: "onboarding", kind: "onboarding", a2aEndpoint: null },
      {
        text: "hi",
        contextId: "D1:1.1",
        metadata: {
          user: null,
          channelId: "D1",
          workspaceId: 0,
          slackTeamId: null,
          eventId: "E2"
        }
      }
    );
    expect(reply).toBe("You said: hi");
  });

  it("throws for a local kind with no binding and no endpoint", async () => {
    await expect(
      dispatchToAgent(
        env,
        { name: "custom-x", kind: "custom", a2aEndpoint: null },
        {
          text: "x",
          contextId: "C1:1.1",
          metadata: {
            user: null,
            channelId: "C1",
            workspaceId: null,
            slackTeamId: null,
            eventId: "E3"
          }
        }
      )
    ).rejects.toThrow(/no a2aEndpoint/i);
  });
});
