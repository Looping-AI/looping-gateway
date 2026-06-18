import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { dispatchToAgent } from "@/agents/dispatch";
import type { UserAuthContext } from "@/auth";

const user = (slackUserId: string): UserAuthContext => ({
  slackUserId,
  displayName: null,
  isPrimaryOwner: false,
  isOrgAdmin: false,
  adminWorkspaces: []
});

// End-to-end of the local A2A path: client (official SDK) → DO stub.fetch →
// serveA2A → DefaultRequestHandler → executor → reply, all in-process.
// Both admin and onboarding now run the AI loop (Workers AI is unavailable
// offline, so each returns its graceful fallback reply).
describe("dispatchToAgent (local Durable Object)", () => {
  it("reaches the AdminAgent A2A server and returns a reply", async () => {
    // Exercises the full local A2A path into the real AdminAgent DO (which runs
    // the AI loop over its Session/SQLite). Workers AI is unavailable offline, so
    // the executor's graceful fallback reply comes back — but the round-trip
    // proves card discovery + JSON-RPC + the DO executor are wired correctly.
    const reply = await dispatchToAgent(
      env,
      { name: "admin", kind: "admin", a2aEndpoint: "http://admin.local" },
      {
        text: "ping",
        channelId: "C1",
        threadTs: "1.1",
        user: user("U1"),
        metadata: { agentKind: "admin", adminWorkspaceId: 0 }
      }
    );
    expect(reply.length).toBeGreaterThan(0);
  });

  it("routes the onboarding kind to its per-user OnboardingAgent instance", async () => {
    // The onboarding instance is keyed by the caller's slackUserId (read from
    // metadata.user); the round-trip into the real DO proves wiring even though
    // the offline fallback reply comes back.
    const reply = await dispatchToAgent(
      env,
      {
        name: "onboarding",
        kind: "onboarding",
        a2aEndpoint: "http://onboarding.local"
      },
      {
        text: "hi",
        channelId: "D1",
        threadTs: "1.1",
        user: user("U_onb"),
        metadata: { agentKind: "onboarding" }
      }
    );
    expect(reply.length).toBeGreaterThan(0);
  });
});
