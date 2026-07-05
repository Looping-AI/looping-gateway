import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import type { Task } from "@a2a-js/sdk";
import { env } from "cloudflare:workers";
import { getDb } from "@/db/client";
import { registerAgent } from "@/db/models/agents";
import {
  setPublicUrl,
  setAllowedRemoteAgentDomains
} from "@/db/models/workspace-configs";
import {
  createAgentTask,
  getAgentTaskByToken,
  completeAgentTask
} from "@/db/models/agent-tasks";
import {
  handleAgentNotification,
  NOTIFICATION_TOKEN_HEADER,
  NOTIFICATIONS_PATH
} from "@/a2a/notifications";

const JKU = "https://agent.example.com/.well-known/jwks.json";
const KID = "cb1";
const ISSUER = "https://gw.example.com";
const AUD = `${ISSUER}${NOTIFICATIONS_PATH}`;
const NTOK = "ntok-123";

const db = getDb();

interface TestKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
}
async function makeKey(kid: string): Promise<TestKey> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "EdDSA";
  publicJwk.use = "sig";
  return { privateKey, publicJwk };
}

async function signCallback(
  key: TestKey,
  opts: { aud?: string } = {}
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: KID, jku: JKU })
    .setSubject("custom:0:remoteagent")
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(key.privateKey);
}

interface SlackPost {
  channel: string;
  text: string;
  thread_ts?: string;
}

/** Stub fetch to serve the pinned JWKS and capture Slack chat.postMessage calls. */
function stubFetch(key: TestKey, posts: SlackPost[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === JKU) {
        return new Response(JSON.stringify({ keys: [key.publicJwk] }), {
          status: 200
        });
      }
      if (url.includes("chat.postMessage")) {
        const raw =
          input instanceof Request
            ? await input.clone().text()
            : String(init?.body ?? "");
        const body = new URLSearchParams(raw);
        posts.push({
          channel: body.get("channel") ?? "",
          text: body.get("text") ?? "",
          thread_ts: body.get("thread_ts") ?? undefined
        });
        return Response.json({ ok: true, ts: "1700.9" });
      }
      return new Response("not found", { status: 404 });
    })
  );
}

function makeTask(text: string): Task {
  return {
    kind: "task",
    id: "task-1",
    contextId: "c1",
    status: {
      state: "completed",
      message: {
        kind: "message",
        messageId: "r1",
        role: "agent",
        parts: [{ kind: "text", text }],
        contextId: "c1"
      }
    }
  };
}

function callbackRequest(bearer: string, token: string, task: Task): Request {
  return new Request(`${ISSUER}${NOTIFICATIONS_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      [NOTIFICATION_TOKEN_HEADER]: token,
      "content-type": "application/json"
    },
    body: JSON.stringify(task)
  });
}

let key: TestKey;

beforeEach(async () => {
  key = await makeKey(KID);
  await registerAgent({
    name: "remoteagent",
    kind: "custom",
    displayName: "Remote",
    a2aEndpoint: "https://agent.example.com/a2a",
    notifyOn: "mention",
    workspaceId: 0,
    cardSigningJku: JKU,
    cardSigningKid: KID
  });
  await setPublicUrl(ISSUER);
  await setAllowedRemoteAgentDomains(["agent.example.com"]);
  await createAgentTask({
    token: NTOK,
    taskId: "task-1",
    agentName: "remoteagent",
    channelId: "C1",
    replyThreadTs: null,
    eventId: "Ev1",
    displayName: "Remote",
    iconUrl: null,
    workspaceId: 0
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("handleAgentNotification", () => {
  it("verifies the callback, posts the reply, and completes the task", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signCallback(key);

    const res = await handleAgentNotification(
      callbackRequest(bearer, NTOK, makeTask("Hello from the agent"))
    );

    expect(res.status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      channel: "C1",
      text: "Hello from the agent"
    });
    expect((await getAgentTaskByToken(NTOK))?.status).toBe("completed");
  });

  it("posts nothing for an empty reply but still completes (no-reply classification)", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signCallback(key);

    const res = await handleAgentNotification(
      callbackRequest(bearer, NTOK, makeTask("   "))
    );

    expect(res.status).toBe(200);
    expect(posts).toHaveLength(0);
    expect((await getAgentTaskByToken(NTOK))?.status).toBe("completed");
  });

  it("rejects a callback whose token is signed for the wrong audience", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signCallback(key, { aud: "https://evil.test/hook" });

    const res = await handleAgentNotification(
      callbackRequest(bearer, NTOK, makeTask("hi"))
    );

    expect(res.status).toBe(401);
    expect(posts).toHaveLength(0);
    expect((await getAgentTaskByToken(NTOK))?.status).toBe("pending");
  });

  it("rejects a callback signed by a key other than the pinned one", async () => {
    const posts: SlackPost[] = [];
    const attacker = await makeKey(KID); // same kid, different key material
    stubFetch(key, posts); // JWKS still serves the real pinned key
    const bearer = await signCallback(attacker);

    const res = await handleAgentNotification(
      callbackRequest(bearer, NTOK, makeTask("hi"))
    );

    expect(res.status).toBe(401);
    expect(posts).toHaveLength(0);
  });

  it("404s an unknown notification token", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signCallback(key);

    const res = await handleAgentNotification(
      callbackRequest(bearer, "nope", makeTask("hi"))
    );
    expect(res.status).toBe(404);
    expect(posts).toHaveLength(0);
  });

  it("is a no-op on a task already completed (replay/duplicate callback)", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await completeAgentTask(NTOK); // pretend a prior callback already ran
    const bearer = await signCallback(key);

    const res = await handleAgentNotification(
      callbackRequest(bearer, NTOK, makeTask("hi"))
    );
    expect(res.status).toBe(200);
    expect(posts).toHaveLength(0);
  });

  it("401s a request missing credentials", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const req = new Request(`${ISSUER}${NOTIFICATIONS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeTask("hi"))
    });
    const res = await handleAgentNotification(req);
    expect(res.status).toBe(401);
  });
});
