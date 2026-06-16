import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { dispatchToAgent } from "@/agents/dispatch";

// End-to-end of the local A2A path: client (official SDK) → DO stub.fetch →
// serveA2A → DefaultRequestHandler → executor → reply, all in-process.
// Onboarding still echoes (Phase 5); admin now runs the AI loop.
describe("dispatchToAgent (local Durable Object)", () => {
  it("reaches the AdminAgent A2A server and returns a reply", async () => {
    // Exercises the full local A2A path into the real AdminAgent DO (which runs
    // the AI loop over its Session/SQLite). Workers AI is unavailable offline, so
    // the executor's graceful fallback reply comes back — but the round-trip
    // proves card discovery + JSON-RPC + the DO executor are wired correctly.
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
    expect(reply.length).toBeGreaterThan(0);
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
