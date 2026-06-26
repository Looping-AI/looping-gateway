import { describe, it, expect, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Message } from "@a2a-js/sdk";
import { importJWK, jwtVerify } from "jose";
import { _resetIssuerCacheForTest, dispatchToAgent } from "@/agents/dispatch";
import { slackTsToIso } from "@/agents/shared/messages";
import type { UserAuthContext } from "@/auth";
import { getPublicJwks, IDENTITY_CLAIM } from "@/auth/agent-jwt";
import { buildAgentCard } from "@/a2a/card";
import { getDb } from "@/db/client";
import {
  setAllowedRemoteAgentDomains,
  setPublicUrl
} from "@/db/models/workspace-configs";

const user = (slackUserId: string): UserAuthContext => ({
  slackUserId,
  displayName: null,
  isPrimaryOwner: false,
  isOrgAdmin: false,
  adminWorkspaces: []
});

const ENDPOINT = "https://remote.example.com/a2a";

interface RemotePost {
  authorization: string | null;
  message: Message;
}

async function publicKey() {
  const { keys } = getPublicJwks(env);
  return importJWK(keys[0], "EdDSA");
}

function stubRemote(posts: RemotePost[]) {
  const card = buildAgentCard({
    name: "Remote",
    description: "remote dispatch test agent",
    url: ENDPOINT
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const method = request.method.toUpperCase();
      if (method === "POST") {
        const rpc = (await request.clone().json()) as {
          id?: unknown;
          params?: { message?: Message };
        };
        posts.push({
          authorization: request.headers.get("authorization"),
          message: rpc.params?.message as Message
        });
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id ?? 1,
          result: {
            kind: "message",
            messageId: "reply-1",
            role: "agent",
            parts: [{ kind: "text", text: "ok" }],
            contextId: "reply"
          }
        });
      }
      return Response.json(card);
    })
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  _resetIssuerCacheForTest();
  const db = getDb(env);
  await setPublicUrl(db, "https://gateway.test");
  await setAllowedRemoteAgentDomains(db, []);
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
      {
        name: "admin",
        kind: "admin",
        a2aEndpoint: "http://admin.local",
        workspaceId: null
      },
      {
        text: "ping",
        channelId: "C1",
        channelName: null,
        threadTs: "1.1",
        messageTs: "1.1",
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
        a2aEndpoint: "http://onboarding.local",
        workspaceId: null
      },
      {
        text: "hi",
        channelId: "D1",
        channelName: null,
        threadTs: "1.1",
        messageTs: "1.1",
        user: user("U_onb"),
        metadata: { agentKind: "onboarding" }
      }
    );
    expect(reply.length).toBeGreaterThan(0);
  });

  it("namespaces remote identity and context per logical agent instance", async () => {
    const db = getDb(env);
    await setPublicUrl(db, "https://gateway.test");
    await setAllowedRemoteAgentDomains(db, ["example.com"]);
    const posts: RemotePost[] = [];
    stubRemote(posts);

    await dispatchToAgent(
      env,
      {
        name: "alpha",
        kind: "custom",
        a2aEndpoint: ENDPOINT,
        workspaceId: 7
      },
      {
        text: "first",
        channelId: "C_SHARED",
        channelName: "general",
        threadTs: "171813.100",
        messageTs: "171813.100",
        user: user("U1"),
        metadata: { agentKind: "custom", workspaceId: 7 }
      }
    );

    await dispatchToAgent(
      env,
      {
        name: "beta",
        kind: "custom",
        a2aEndpoint: ENDPOINT,
        workspaceId: 7
      },
      {
        text: "second",
        channelId: "C_SHARED",
        channelName: null,
        threadTs: "171813.100",
        messageTs: "171813.200",
        user: { ...user("U2"), displayName: "Grace" },
        metadata: { agentKind: "custom", workspaceId: 7 }
      }
    );

    expect(posts).toHaveLength(2);
    expect(posts[0].authorization?.startsWith("Bearer ")).toBe(true);
    expect(posts[1].authorization?.startsWith("Bearer ")).toBe(true);
    expect(posts[0].message.contextId).not.toBe(posts[1].message.contextId);
    expect(posts[0].message.contextId).toContain(
      encodeURIComponent("custom:7:alpha")
    );
    expect(posts[1].message.contextId).toContain(
      encodeURIComponent("custom:7:beta")
    );
    // No structured provenance on the wire — who/where/when is inlined into the
    // turn text by the Gateway. Metadata carries only routing extras.
    expect(posts[0].message.metadata).toMatchObject({
      agentKind: "custom",
      workspaceId: 7
    });
    expect(posts[0].message.metadata).not.toHaveProperty("provenance");
    expect(posts[0].message.parts[0]).toMatchObject({
      kind: "text",
      text:
        `<turn from="U1" id="U1" channel="general" ` +
        `at="${slackTsToIso("171813.100")}">first</turn>`
    });
    // Beta's caller has a display name and no resolved channel → id fallback.
    expect(posts[1].message.parts[0]).toMatchObject({
      kind: "text",
      text:
        `<turn from="Grace" id="U2" channel="C_SHARED" ` +
        `at="${slackTsToIso("171813.200")}">second</turn>`
    });

    const tokenA = posts[0].authorization?.split(" ")[1] ?? "";
    const tokenB = posts[1].authorization?.split(" ")[1] ?? "";
    const [{ payload: payloadA }, { payload: payloadB }] = await Promise.all([
      jwtVerify(tokenA, await publicKey(), {
        issuer: "https://gateway.test",
        audience: "https://remote.example.com",
        algorithms: ["EdDSA"]
      }),
      jwtVerify(tokenB, await publicKey(), {
        issuer: "https://gateway.test",
        audience: "https://remote.example.com",
        algorithms: ["EdDSA"]
      })
    ]);

    expect(payloadA.sub).toBe("custom:7:alpha");
    expect(payloadB.sub).toBe("custom:7:beta");
    expect(payloadA[IDENTITY_CLAIM]).toMatchObject({
      key: "custom:7:alpha",
      name: "alpha",
      kind: "custom",
      workspaceId: 7
    });
    expect(payloadB[IDENTITY_CLAIM]).toMatchObject({
      key: "custom:7:beta",
      name: "beta",
      kind: "custom",
      workspaceId: 7
    });
  });
});
