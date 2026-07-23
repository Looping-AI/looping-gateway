import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Message } from "@a2a-js/sdk";
import { jwtVerify } from "jose";
import {
  _resetIssuerCacheForTest,
  dispatchToAgent,
  cancelAgentTask,
  timeoutAgentTask,
  buildDispatchId
} from "@/agents/dispatch";
import { slackTsToIso } from "@/agents/shared/messages";
import type { UserAuthContext } from "@/auth";
import { IDENTITY_CLAIM } from "@/auth/agent-outbound";
import { importGatewayPublicKey } from "../helpers/auth";
import { buildAgentCard } from "@/a2a/card";
import { HITL_TIMEOUT_TYPE } from "@/a2a/hitl";
import { registerAgent } from "@/db/models/agents";
import {
  createAgentTask,
  suspendForInput,
  getAgentTaskByToken
} from "@/db/models/agent-tasks";
import {
  createHitlRequest,
  getHitlRequest,
  type HitlRequestRow
} from "@/db/models/hitl-requests";
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

/** A `chat.postMessage` the gateway sent to the thread (e.g. a failure notice). */
interface SlackNotice {
  channel: string;
  text: string;
  thread_ts?: string;
}

/** Record a `chat.postMessage` call into `notices` and ack it like Slack would. */
async function captureSlackNotice(
  request: Request,
  notices?: SlackNotice[]
): Promise<Response> {
  if (notices) {
    const body = new URLSearchParams(await request.clone().text());
    notices.push({
      channel: body.get("channel") ?? "",
      text: body.get("text") ?? "",
      thread_ts: body.get("thread_ts") ?? undefined
    });
  }
  return Response.json({ ok: true, ts: "1700.notice" });
}

function stubRemote(posts: RemotePost[], notices?: SlackNotice[]) {
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
      if (request.url.includes("chat.postMessage")) {
        return captureSlackNotice(request, notices);
      }
      if (method === "POST") {
        const rpc = (await request.clone().json()) as {
          id?: unknown;
          params?: { message?: Message };
        };
        posts.push({
          authorization: request.headers.get("authorization"),
          message: rpc.params?.message as Message
        });
        // Async contract: a remote returns a Task ack immediately, not a reply.
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id ?? 1,
          result: {
            kind: "task",
            id: "task-remote-1",
            contextId: "reply",
            status: { state: "submitted" }
          }
        });
      }
      return Response.json(card);
    })
  );
}

function stubRemoteContractViolation(
  posts: RemotePost[],
  notices?: SlackNotice[]
) {
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
      if (request.url.includes("chat.postMessage")) {
        return captureSlackNotice(request, notices);
      }
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
            messageId: "r1",
            role: "agent",
            parts: [{ kind: "text", text: "sync reply" }],
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
  await setPublicUrl("https://gateway.test");
  await setAllowedRemoteAgentDomains([]);
});

// End-to-end of the local A2A path: client (official SDK) → DO stub.fetch →
// serveA2A → DefaultRequestHandler → executor → Task acceptance, all in-process.
// Reply delivery itself uses the trusted local notification sender.
describe("dispatchToAgent (local Durable Object)", () => {
  it("reaches the AdminAgent A2A server and accepts a task", async () => {
    // Exercises the full local A2A path into the real AdminAgent DO (which runs
    // the AI loop over its Session/SQLite). The response is an A2A Task; status
    // snapshots are delivered through the local sender instead of inline.
    const result = await dispatchToAgent(
      {
        name: "admin",
        kind: "admin",
        a2aEndpoint: "http://admin.local",
        workspaceId: 0
      },
      {
        eventId: "Ev-admin",
        text: "ping",
        channelId: "C1",
        channelName: null,
        threadTs: "1.1",
        messageTs: "1.1",
        user: user("U1"),
        metadata: { agentKind: "admin", adminWorkspaceId: 0 }
      }
    );
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") {
      expect(result.taskId.length).toBeGreaterThan(0);
      expect(result.token).toBe(
        await buildDispatchId("Ev-admin", {
          name: "admin",
          kind: "admin",
          workspaceId: 0
        })
      );
    }
  });

  it("routes onboarding to its per-user instance and accepts a task", async () => {
    // The onboarding instance is keyed by the caller's slackUserId (read from
    // metadata.user); the round-trip into the real DO proves wiring before the
    // in-process sender delivers its task status snapshots.
    const result = await dispatchToAgent(
      {
        name: "onboarding",
        kind: "onboarding",
        a2aEndpoint: "http://onboarding.local",
        workspaceId: 0
      },
      {
        eventId: "Ev-onb",
        text: "hi",
        channelId: "D1",
        channelName: null,
        threadTs: "1.1",
        messageTs: "1.1",
        user: user("U_onb"),
        metadata: { agentKind: "onboarding" }
      }
    );
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") {
      expect(result.taskId.length).toBeGreaterThan(0);
      expect(result.token).toBe(
        await buildDispatchId("Ev-onb", {
          name: "onboarding",
          kind: "onboarding",
          workspaceId: 0
        })
      );
    }
  });

  it("namespaces remote identity and context per logical agent instance", async () => {
    await setPublicUrl("https://gateway.test");
    await setAllowedRemoteAgentDomains(["example.com"]);
    const posts: RemotePost[] = [];
    stubRemote(posts);

    await dispatchToAgent(
      {
        name: "alpha",
        kind: "custom",
        a2aEndpoint: ENDPOINT,
        workspaceId: 7
      },
      {
        eventId: "Ev-alpha",
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
      {
        name: "beta",
        kind: "custom",
        a2aEndpoint: ENDPOINT,
        workspaceId: 7
      },
      {
        eventId: "Ev-beta",
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
    // messageId is the deterministic dispatch id — a compact 19-char base36 hash
    // of {eventId}:{instanceKey}, so a retried dispatch is dedupable by the remote
    // rather than appended twice, and it leaks neither the event id nor the key.
    expect(posts[0].message.messageId).toMatch(/^[0-9a-z]{19}$/);
    expect(posts[1].message.messageId).toMatch(/^[0-9a-z]{19}$/);
    expect(posts[0].message.messageId).not.toBe(posts[1].message.messageId);
    // Determinism: recomputing from the same inputs yields the same id.
    expect(
      await buildDispatchId("Ev-alpha", {
        name: "alpha",
        kind: "custom",
        workspaceId: 7
      })
    ).toBe(posts[0].message.messageId);
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
      jwtVerify(tokenA, await importGatewayPublicKey(), {
        issuer: "https://gateway.test",
        audience: "https://remote.example.com",
        algorithms: ["EdDSA"]
      }),
      jwtVerify(tokenB, await importGatewayPublicKey(), {
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

  it("returns contract_violation when required Task acceptance/id is missing", async () => {
    await setPublicUrl("https://gateway.test");
    await setAllowedRemoteAgentDomains(["example.com"]);
    const posts: RemotePost[] = [];
    stubRemoteContractViolation(posts);

    const result = await dispatchToAgent(
      {
        name: "remote-bad",
        kind: "custom",
        a2aEndpoint: ENDPOINT,
        workspaceId: 7
      },
      {
        eventId: "Ev-bad-remote",
        text: "hello",
        channelId: "C1",
        channelName: "general",
        threadTs: "171813.100",
        messageTs: "171813.100",
        user: user("U1"),
        metadata: { agentKind: "custom", workspaceId: 7 }
      }
    );

    expect(result.kind).toBe("error_reply");
    if (result.kind === "error_reply") {
      expect(result.text).toContain("required task acknowledgment");
    }
    expect(posts).toHaveLength(1);
  });
});

describe("cancelAgentTask", () => {
  it("is a no-op for local built-in agents (never contacts them)", async () => {
    const fetchSpy = vi.fn(async () => new Response("x", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);

    const out = await cancelAgentTask(
      {
        name: "admin",
        kind: "admin",
        a2aEndpoint: "http://admin.local",
        workspaceId: 0
      },
      "task-1"
    );
    expect(out).toEqual({ kind: "not_cancelable" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("signs a gateway JWT and cancels a remote task", async () => {
    await setPublicUrl("https://gateway.test");
    await setAllowedRemoteAgentDomains(["example.com"]);
    const posts: RemotePost[] = [];
    stubRemote(posts);

    const out = await cancelAgentTask(
      { name: "alpha", kind: "custom", a2aEndpoint: ENDPOINT, workspaceId: 7 },
      "task-9"
    );
    expect(out.kind).toBe("canceled");
    expect(posts.at(-1)?.authorization).toMatch(/^Bearer /);
  });
});

// The TTL-timeout continuation: when a HITL prompt expires with no answer, the
// gateway continues the parked task with a HITL_TIMEOUT DataPart so the agent can
// finalize, authorizing as the zero-permission SYSTEM_CALLER. This exercises the
// remote branch of sendTaskContinuation (custom-agent HTTP), which the human-answer
// path (resumeAgentTask) shares — the timeout branch was previously uncovered.
describe("timeoutAgentTask (remote continuation)", () => {
  const TOKEN = "tok-timeout";
  const TASK_ID = "task-1";
  const CONTEXT_ID = "C1:1700.1";
  const REQUEST_ID = "req-timeout-1";

  // Register a custom (remote) agent, record its dispatched task, and park it on an
  // open HITL prompt — the exact state a timeout sweep continues from. Returns the
  // persisted request row that timeoutAgentTask consumes.
  async function setupParkedRow(): Promise<HitlRequestRow> {
    await registerAgent({
      name: "alpha",
      kind: "custom",
      a2aEndpoint: ENDPOINT,
      notifyOn: "mention",
      workspaceId: 0
    });
    await createAgentTask({
      token: TOKEN,
      taskId: TASK_ID,
      agentName: "alpha",
      channelId: "C1",
      messageTs: "1700.1",
      replyThreadTs: "1700.1",
      eventId: "Ev-timeout"
    });
    // pending → awaiting-input: the task is suspended while the prompt is open.
    await suspendForInput(TOKEN);
    await createHitlRequest({
      requestId: REQUEST_ID,
      token: TOKEN,
      taskId: TASK_ID,
      contextId: CONTEXT_ID,
      agentName: "alpha",
      channelId: "C1",
      threadTs: "1700.1",
      requestKind: "approval",
      promptText: "Proceed?",
      optionsJson: null,
      allowFreeform: false,
      deadlineAt: Math.floor(Date.now() / 1000) - 1
    });
    const row = await getHitlRequest(REQUEST_ID);
    if (!row) throw new Error("failed to seed HITL request row");
    return row;
  }

  beforeEach(async () => {
    await setPublicUrl("https://gateway.test");
    await setAllowedRemoteAgentDomains(["example.com"]);
  });

  it("continues the paused task with a timeout DataPart, then un-parks it on accept", async () => {
    const posts: RemotePost[] = [];
    stubRemote(posts);
    const row = await setupParkedRow();

    await timeoutAgentTask(row);

    expect(posts).toHaveLength(1);
    const msg = posts[0].message;
    // Authorized as the signed gateway identity (SYSTEM_CALLER never crosses the
    // remote boundary — only the gateway-agent JWT does).
    expect(posts[0].authorization?.startsWith("Bearer ")).toBe(true);
    // A2A multi-turn: continue the same task on the same thread of conversation.
    expect(msg.taskId).toBe(TASK_ID);
    expect(msg.contextId).toBe(CONTEXT_ID);
    expect(msg.referenceTaskIds).toEqual([TASK_ID]);
    // Deterministic, request-scoped messageId so a retried timeout dedupes at the remote.
    expect(msg.messageId).toBe(`${TOKEN}:t:${REQUEST_ID}`);
    // Carries the HITL timeout signal (human-readable TextPart + structured DataPart).
    expect(msg.parts).toEqual([
      {
        kind: "text",
        text: "(No response was received within the allotted time.)"
      },
      { kind: "data", data: { type: HITL_TIMEOUT_TYPE, requestId: REQUEST_ID } }
    ]);
    // Only routing extras on the wire — no caller/permission context.
    expect(msg.metadata).toEqual({ agentKind: "custom", workspaceId: 0 });

    // Accepted → the row is un-parked (awaiting-input → pending) so the resumed
    // turn's terminal callback is honored on the same agent_tasks row.
    expect((await getAgentTaskByToken(TOKEN))?.status).toBe("pending");
  });

  it("reuses a stable messageId across an at-least-once retry and only un-parks once", async () => {
    const posts: RemotePost[] = [];
    stubRemote(posts);
    const row = await setupParkedRow();

    await timeoutAgentTask(row);
    await timeoutAgentTask(row); // same timeout redelivered

    expect(posts).toHaveLength(2);
    // Identical id both times → the remote collapses the duplicate rather than
    // appending the timeout turn twice.
    expect(posts[0].message.messageId).toBe(`${TOKEN}:t:${REQUEST_ID}`);
    expect(posts[1].message.messageId).toBe(posts[0].message.messageId);
    // Still pending: the second resumeFromInput is a no-op (already un-parked).
    expect((await getAgentTaskByToken(TOKEN))?.status).toBe("pending");
  });

  it("leaves the task parked and notifies the thread when the remote does not accept the continuation", async () => {
    const posts: RemotePost[] = [];
    const notices: SlackNotice[] = [];
    stubRemoteContractViolation(posts, notices);
    const row = await setupParkedRow();

    await timeoutAgentTask(row);

    expect(posts).toHaveLength(1);
    // No Task ack → resumeFromInput is skipped, so the row stays suspended and a
    // later sweep can retry rather than stranding it as un-parked-but-unresumed.
    expect((await getAgentTaskByToken(TOKEN))?.status).toBe("awaiting-input");
    // The user is told the agent couldn't be reached, so a silently-down agent
    // doesn't leave them staring at a prompt that never resolves.
    expect(notices).toHaveLength(1);
    expect(notices[0].thread_ts).toBe("1700.1");
    expect(notices[0].text).toContain("alpha");
    expect(notices[0].text.toLowerCase()).toContain("unreachable");
  });
});
