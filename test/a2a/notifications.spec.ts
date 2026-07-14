import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Task, TaskState } from "@a2a-js/sdk";
import { InMemoryPushNotificationStore } from "@a2a-js/sdk/server";
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
  handleRemoteAgentNotification,
  NOTIFICATION_TOKEN_HEADER,
  NOTIFICATIONS_PATH
} from "@/a2a/notifications/remote";
import {
  deliverLocalAgentTask,
  LocalPushNotificationSender,
  localPushNotificationConfig
} from "@/a2a/notifications/local";
import { makeKey, signJwt, type TestKey } from "../helpers/auth";

const JKU = "https://agent.example.com/.well-known/jwks.json";
const KID = "cb1";
const ISSUER = "https://gw.example.com";
const AUD = `${ISSUER}${NOTIFICATIONS_PATH}`;
const SUB = "custom:0:remoteagent";
const NTOK = "ntok-123";

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
  return makeStatusTask(text, { state: "completed", messageId: "r1" });
}

/** Build a Task callback with an explicit state + status-message id. */
function makeStatusTask(
  text: string,
  opts: { state: TaskState; messageId?: string }
): Task {
  return {
    kind: "task",
    id: "task-1",
    contextId: "c1",
    status: {
      state: opts.state,
      message: {
        kind: "message",
        messageId: opts.messageId ?? "r1",
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
    eventId: "Ev1"
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("handleRemoteAgentNotification", () => {
  it("verifies the callback, posts the reply, and completes the task", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

    const res = await handleRemoteAgentNotification(
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
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, makeTask("   "))
    );

    expect(res.status).toBe(200);
    expect(posts).toHaveLength(0);
    expect((await getAgentTaskByToken(NTOK))?.status).toBe("completed");
  });

  it("rejects a callback whose token is signed for the wrong audience", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, {
      jku: JKU,
      sub: SUB,
      aud: "https://evil.test/hook"
    });

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, makeTask("hi"))
    );

    expect(res.status).toBe(401);
    expect(posts).toHaveLength(0);
    const row = await getAgentTaskByToken(NTOK);
    expect(row?.status).toBe("pending");
    // The reason is captured (still pending) so the reaction backstop can surface it.
    expect(row?.lastError).toContain("signature could not be verified");
  });

  it("rejects a callback signed by a key other than the pinned one", async () => {
    const posts: SlackPost[] = [];
    const attacker = await makeKey(KID); // same kid, different key material
    stubFetch(key, posts); // JWKS still serves the real pinned key
    const bearer = await signJwt(attacker, { jku: JKU, sub: SUB, aud: AUD });

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, makeTask("hi"))
    );

    expect(res.status).toBe(401);
    expect(posts).toHaveLength(0);
  });

  it("400s and records the reason when the body is not a Task", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });
    const req = new Request(`${ISSUER}${NOTIFICATIONS_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        [NOTIFICATION_TOKEN_HEADER]: NTOK,
        "content-type": "application/json"
      },
      body: JSON.stringify({ kind: "message", not: "a task" })
    });

    const res = await handleRemoteAgentNotification(req);

    expect(res.status).toBe(400);
    expect(posts).toHaveLength(0);
    const row = await getAgentTaskByToken(NTOK);
    expect(row?.status).toBe("pending");
    expect(row?.lastError).toContain("not a valid A2A Task");
  });

  it("400s a Task-kind body missing status without reaching delivery", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });
    const req = new Request(`${ISSUER}${NOTIFICATIONS_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        [NOTIFICATION_TOKEN_HEADER]: NTOK,
        "content-type": "application/json"
      },
      // kind: "task" but no status → would crash on task.status.state if cast.
      body: JSON.stringify({ kind: "task", id: "task-1", contextId: "c1" })
    });

    const res = await handleRemoteAgentNotification(req);

    expect(res.status).toBe(400);
    expect(posts).toHaveLength(0);
    const row = await getAgentTaskByToken(NTOK);
    expect(row?.status).toBe("pending");
    expect(row?.lastError).toContain("not a valid A2A Task");
  });

  it("posts an intermediate (non-terminal) update, keeps the task pending, and keeps the ⏳", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

    const res = await handleRemoteAgentNotification(
      callbackRequest(
        bearer,
        NTOK,
        makeStatusTask("working on it", { state: "working", messageId: "u1" })
      )
    );

    expect(res.status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: "C1", text: "working on it" });
    const row = await getAgentTaskByToken(NTOK);
    // Row stays pending (⏳ not collected) and the update is recorded for dedup.
    expect(row?.status).toBe("pending");
    expect(row?.receivedMessageIds).toBe("u1");
  });

  it("400s a non-terminal update missing a messageId and records the reason", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });
    const noIdTask: Task = {
      kind: "task",
      id: "task-1",
      contextId: "c1",
      status: { state: "working" } // no status.message → no messageId
    };

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, noIdTask)
    );

    expect(res.status).toBe(400);
    expect(posts).toHaveLength(0);
    const row = await getAgentTaskByToken(NTOK);
    expect(row?.status).toBe("pending");
    expect(row?.lastError).toContain("messageId");
  });

  it("dedupes a replayed intermediate update by messageId but posts distinct ones", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

    await handleRemoteAgentNotification(
      callbackRequest(
        bearer,
        NTOK,
        makeStatusTask("step one", { state: "working", messageId: "u1" })
      )
    );
    // Same messageId again (at-least-once retry) → not re-posted.
    await handleRemoteAgentNotification(
      callbackRequest(
        bearer,
        NTOK,
        makeStatusTask("step one", { state: "working", messageId: "u1" })
      )
    );
    // Distinct messageId → posted.
    await handleRemoteAgentNotification(
      callbackRequest(
        bearer,
        NTOK,
        makeStatusTask("step two", { state: "working", messageId: "u2" })
      )
    );

    expect(posts.map((p) => p.text)).toEqual(["step one", "step two"]);
    const row = await getAgentTaskByToken(NTOK);
    expect(row?.status).toBe("pending");
    expect((row?.receivedMessageIds ?? "").split(",").sort()).toEqual([
      "u1",
      "u2"
    ]);
  });

  it("posts intermediate updates then completes on the terminal Task", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

    await handleRemoteAgentNotification(
      callbackRequest(
        bearer,
        NTOK,
        makeStatusTask("searching…", { state: "working", messageId: "u1" })
      )
    );
    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, makeTask("final answer"))
    );

    expect(res.status).toBe(200);
    expect(posts.map((p) => p.text)).toEqual(["searching…", "final answer"]);
    expect((await getAgentTaskByToken(NTOK))?.status).toBe("completed");
  });

  it("delivers a trusted local built-in Task without accepting it on the public callback", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await registerAgent({
      name: "adminlocal",
      kind: "admin",
      displayName: "Admin Local",
      a2aEndpoint: "https://agent.local/a2a",
      notifyOn: "mention",
      workspaceId: 0
    });
    await createAgentTask({
      token: "local-token",
      taskId: "local-task",
      agentName: "adminlocal",
      channelId: "C-local",
      replyThreadTs: null,
      eventId: "Ev-local"
    });

    await deliverLocalAgentTask(
      "local-token",
      makeStatusTask("checking that", { state: "working", messageId: "u1" }),
      "admin"
    );
    await deliverLocalAgentTask(
      "local-token",
      makeTask("Here is the answer"),
      "admin"
    );

    expect(posts.map((post) => post.text)).toEqual([
      "checking that",
      "Here is the answer"
    ]);
    expect((await getAgentTaskByToken("local-token"))?.status).toBe(
      "completed"
    );
  });

  it("sanitizes a local built-in reply before posting (defangs broadcast sequences)", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await registerAgent({
      name: "adminsanitize",
      kind: "admin",
      displayName: "Admin Sanitize",
      a2aEndpoint: "https://agent.local/a2a",
      notifyOn: "mention",
      workspaceId: 0
    });
    await createAgentTask({
      token: "local-sanitize-token",
      taskId: "local-sanitize-task",
      agentName: "adminsanitize",
      channelId: "C-local",
      replyThreadTs: null,
      eventId: "Ev-local-sanitize"
    });

    // A built-in agent still relays untrusted model output — the reply is
    // sanitized before it reaches Slack, just like a remote agent's.
    await deliverLocalAgentTask(
      "local-sanitize-token",
      makeTask("hey <!channel> listen"),
      "admin"
    );

    expect(posts).toHaveLength(1);
    expect(posts[0].text).not.toContain("<!channel>");
    expect(posts[0].text).toContain("@channel");
  });

  it("rejects a built-in agent's token on the public remote callback (401, nothing posted)", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await registerAgent({
      name: "adminpublic",
      kind: "admin",
      displayName: "Admin Public",
      a2aEndpoint: "https://agent.local/a2a",
      notifyOn: "mention",
      workspaceId: 0
    });
    await createAgentTask({
      token: "local-public-token",
      taskId: "local-public-task",
      agentName: "adminpublic",
      channelId: "C-local",
      replyThreadTs: null,
      eventId: "Ev-local-public"
    });

    // A built-in agent's task must never be completable through the public HTTP
    // callback — it is delivered in-process. The kind check rejects it before any
    // signature verification or Slack post, even with a bearer present.
    const res = await handleRemoteAgentNotification(
      callbackRequest(
        "any-bearer",
        "local-public-token",
        makeTask("smuggled reply")
      )
    );

    expect(res.status).toBe(401);
    expect(posts).toHaveLength(0);
    const row = await getAgentTaskByToken("local-public-token");
    expect(row?.status).toBe("pending");
    expect(row?.lastError).toContain("delivered internally");
  });

  it("suppresses a submitted local Task even when it includes text", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await registerAgent({
      name: "adminsender",
      kind: "admin",
      displayName: "Admin Sender",
      a2aEndpoint: "https://agent.local/a2a",
      notifyOn: "mention",
      workspaceId: 0
    });
    await createAgentTask({
      token: "local-sender-token",
      taskId: "local-sender-task",
      agentName: "adminsender",
      channelId: "C-local",
      replyThreadTs: null,
      eventId: "Ev-local-sender"
    });

    const store = new InMemoryPushNotificationStore();
    await store.save(
      "local-sender-task",
      localPushNotificationConfig("local-sender-token")
    );
    const sender = new LocalPushNotificationSender(store, "admin");

    await sender.send({
      ...makeStatusTask("acceptance text", {
        state: "submitted",
        messageId: "submitted-message"
      }),
      id: "local-sender-task"
    });
    await sender.send({
      ...makeStatusTask("working update", {
        state: "working",
        messageId: "working-message"
      }),
      id: "local-sender-task"
    });

    expect(posts.map((post) => post.text)).toEqual(["working update"]);
  });

  it("surfaces a gateway notice and completes on a terminal failure with no text", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });
    const failed: Task = {
      ...makeTask("ignored"),
      status: { state: "failed" }
    };

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, NTOK, failed)
    );

    expect(res.status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain("ended without a reply (state: failed)");
    expect((await getAgentTaskByToken(NTOK))?.status).toBe("completed");
  });

  it("404s an unknown notification token", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

    const res = await handleRemoteAgentNotification(
      callbackRequest(bearer, "nope", makeTask("hi"))
    );
    expect(res.status).toBe(404);
    expect(posts).toHaveLength(0);
  });

  it("is a no-op on a task already completed (replay/duplicate callback)", async () => {
    const posts: SlackPost[] = [];
    stubFetch(key, posts);
    await completeAgentTask(NTOK); // pretend a prior callback already ran
    const bearer = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

    const res = await handleRemoteAgentNotification(
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
    const res = await handleRemoteAgentNotification(req);
    expect(res.status).toBe(401);
  });
});
