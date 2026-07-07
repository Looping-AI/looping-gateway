import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { handleSlackEvent } from "@/slack-webhook-handler";
import { AGENT_UNREACHABLE_TEXT } from "@/workflows/message-helpers";
import { PENDING_REACTION } from "@/workflows/reaction";
import { buildDispatchId, _resetIssuerCacheForTest } from "@/agents/dispatch";
import { getAgentTaskByToken } from "@/db/models/agent-tasks";
import {
  setAllowedRemoteAgentDomains,
  setPublicUrl
} from "@/db/models/workspace-configs";
import { buildAgentCard } from "@/a2a/card";
import { slackHeaders } from "../helpers/slack";

const REMOTE_ENDPOINT = "https://remote.example.com/a2a";
const REMOTE_CHANNEL = "C_REMOTE";
const AGENT_NAME = "remote-test";

interface PostCall {
  channel: string;
  text: string;
  thread_ts?: string;
}

interface ReactionCall {
  method: string;
  channel: string;
  timestamp: string;
  name: string;
}

/**
 * Stub global fetch to route Slack API calls and remote agent calls separately.
 * The remote endpoint returns either an accepted Task ack or a contract-violating
 * Message (which `dispatchToAgent` normalises to `error_reply`).
 */
function stubFetch({
  remoteMode = "accepted" as "accepted" | "contract_violation",
  slackPosts,
  slackReactions
}: {
  remoteMode?: "accepted" | "contract_violation";
  slackPosts?: PostCall[];
  slackReactions?: ReactionCall[];
} = {}) {
  const card = buildAgentCard({
    name: "Remote Test",
    description: "test remote agent",
    url: REMOTE_ENDPOINT
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = request.url;

      // Route Slack API calls (chat.postMessage, reactions.add / .remove, etc.)
      if (url.includes("slack.com")) {
        const method = new URL(url).pathname.split("/").pop() ?? "";
        const raw = typeof init?.body === "string" ? init.body : "";
        const params = new URLSearchParams(raw);
        if (method === "chat.postMessage" && slackPosts) {
          slackPosts.push({
            channel: params.get("channel") ?? "",
            text: params.get("text") ?? "",
            thread_ts: params.get("thread_ts") ?? undefined
          });
        }
        if (
          (method === "reactions.add" || method === "reactions.remove") &&
          slackReactions
        ) {
          slackReactions.push({
            method,
            channel: params.get("channel") ?? "",
            timestamp: params.get("timestamp") ?? "",
            name: params.get("name") ?? ""
          });
        }
        return new Response(JSON.stringify({ ok: true, ts: "1700.5" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      // Remote agent card discovery (GET).
      if (request.method === "GET") return Response.json(card);

      // Remote agent dispatch (POST).
      const rpc = (await request.clone().json()) as { id?: unknown };

      if (remoteMode === "accepted") {
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id ?? 1,
          result: {
            kind: "task",
            id: "task-remote-1",
            contextId: "ctx",
            status: { state: "submitted" }
          }
        });
      }

      // contract_violation: returns a Message instead of a Task.
      // dispatchToAgent normalises this to { kind: "error_reply" }.
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id ?? 1,
        result: {
          kind: "message",
          messageId: "m1",
          role: "agent",
          parts: [{ kind: "text", text: "unexpected sync reply" }],
          contextId: "ctx"
        }
      });
    })
  );
}

let seq = 0;
function makeChannelMessageRequest(channelId: string) {
  const eventId = `Ev-remote-${++seq}`;
  const body = JSON.stringify({
    type: "event_callback",
    event_id: eventId,
    team_id: "T1",
    event: {
      type: "message",
      channel_type: "channel",
      channel: channelId,
      user: "U1",
      text: "hello remote",
      ts: "1700.1",
      event_ts: "1700.1"
    }
  });
  return { body, eventId };
}

async function trigger(body: string) {
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waitUntilPromises.push(p);
    },
    passThroughOnException: () => {}
  } as unknown as ExecutionContext;
  const res = await handleSlackEvent(
    new Request("https://example.com/slack/events", {
      method: "POST",
      headers: await slackHeaders(body),
      body
    }),
    ctx
  );
  await Promise.allSettled(waitUntilPromises);
  return res;
}

// Compute the deterministic push token the workflow uses for this event + agent.
async function tokenFor(eventId: string): Promise<string> {
  return buildDispatchId(eventId, {
    name: AGENT_NAME,
    kind: "custom",
    workspaceId: 0
  });
}

beforeEach(async () => {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO agents
       (name, kind, enabled, notify_on, a2a_endpoint, workspace_id)
     VALUES ('${AGENT_NAME}', 'custom', 1, 'channel_messages', '${REMOTE_ENDPOINT}', 0)`
  ).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO agent_channels (channel_id, agent_name, workspace_id)
     VALUES ('${REMOTE_CHANNEL}', '${AGENT_NAME}', 0)`
  ).run();
  await setPublicUrl("https://gateway.test");
  await setAllowedRemoteAgentDomains(["remote.example.com"]);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  _resetIssuerCacheForTest();
  await setAllowedRemoteAgentDomains([]);
});

describe("RemoteMessageWorkflow", () => {
  it("record-task pre-writes the correlation row; update-task backfills the remote taskId on accepted", async () => {
    stubFetch({ remoteMode: "accepted" });
    const introspector = await introspectWorkflow(env.REMOTE_MESSAGE_WORKFLOW);
    try {
      const { body, eventId } = makeChannelMessageRequest(REMOTE_CHANNEL);
      expect((await trigger(body)).status).toBe(200);

      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // record-task wrote the row before dispatch, update-task backfilled taskId.
      const row = await getAgentTaskByToken(await tokenFor(eventId));
      expect(row).not.toBeNull();
      expect(row?.taskId).toBe("task-remote-1");
      expect(row?.agentName).toBe(AGENT_NAME);
    } finally {
      await introspector.dispose();
    }
  });

  it("task row deleted when dispatch ends in error_reply (remote contract violation)", async () => {
    const slackPosts: PostCall[] = [];
    stubFetch({ remoteMode: "contract_violation", slackPosts });
    const introspector = await introspectWorkflow(env.REMOTE_MESSAGE_WORKFLOW);
    try {
      const { body, eventId } = makeChannelMessageRequest(REMOTE_CHANNEL);
      expect((await trigger(body)).status).toBe(200);

      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // No push callback will arrive — the row must be cleaned up.
      expect(await getAgentTaskByToken(await tokenFor(eventId))).toBeNull();
      // The error_reply text is posted to Slack so the user isn't left in silence.
      expect(slackPosts).toHaveLength(1);
      expect(slackPosts[0].text).toContain("required task acknowledgment");
    } finally {
      await introspector.dispose();
    }
  });

  it("task row deleted and unreachable notice posted when dispatch retries exhausted", async () => {
    const slackPosts: PostCall[] = [];
    stubFetch({ slackPosts });
    const introspector = await introspectWorkflow(env.REMOTE_MESSAGE_WORKFLOW);
    try {
      await introspector.modifyAll(async (m) => {
        await m.disableRetryDelays([{ name: `dispatch:${AGENT_NAME}` }]);
        await m.mockStepError(
          { name: `dispatch:${AGENT_NAME}` },
          new Error("connection refused")
        );
      });

      const { body, eventId } = makeChannelMessageRequest(REMOTE_CHANNEL);
      expect((await trigger(body)).status).toBe(200);

      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // No push callback will arrive — row must be gone.
      expect(await getAgentTaskByToken(await tokenFor(eventId))).toBeNull();
      // User gets an explicit notice instead of silence.
      expect(slackPosts).toHaveLength(1);
      expect(slackPosts[0]).toMatchObject({
        channel: REMOTE_CHANNEL,
        text: AGENT_UNREACHABLE_TEXT
      });
    } finally {
      await introspector.dispose();
    }
  });

  it("collect-reaction fires when all dispatches end in non-accepted (error_reply)", async () => {
    const slackReactions: ReactionCall[] = [];
    stubFetch({ remoteMode: "contract_violation", slackReactions });
    const msgIntrospector = await introspectWorkflow(
      env.REMOTE_MESSAGE_WORKFLOW
    );
    const reactionIntrospector = await introspectWorkflow(
      env.REACTION_WORKFLOW
    );
    try {
      const { body } = makeChannelMessageRequest(REMOTE_CHANNEL);
      expect((await trigger(body)).status).toBe(200);

      const [msg] = await msgIntrospector.get();
      const [reaction] = await reactionIntrospector.get();
      await msg.waitForStatus("complete");
      await reaction.waitForStatus("complete");

      // ⏳ added by the handler; removed after the collect-reaction signal.
      expect(slackReactions.map((r) => r.method)).toEqual([
        "reactions.add",
        "reactions.remove"
      ]);
      expect(slackReactions[0]).toMatchObject({
        name: PENDING_REACTION,
        channel: REMOTE_CHANNEL
      });
    } finally {
      await msgIntrospector.dispose();
      await reactionIntrospector.dispose();
    }
  });

  it("collect-reaction suppressed while at least one dispatch is accepted", async () => {
    const slackReactions: ReactionCall[] = [];
    stubFetch({ remoteMode: "accepted", slackReactions });
    const msgIntrospector = await introspectWorkflow(
      env.REMOTE_MESSAGE_WORKFLOW
    );
    try {
      const { body } = makeChannelMessageRequest(REMOTE_CHANNEL);
      expect((await trigger(body)).status).toBe(200);

      const [instance] = await msgIntrospector.get();
      await instance.waitForStatus("complete");

      // Message workflow completed but no collect-reaction signal was sent —
      // the ⏳ must persist until the push-notification callback (or backstop)
      // removes it, so the user sees "in progress" until the agent actually replies.
      expect(
        slackReactions.filter((r) => r.method === "reactions.add")
      ).toHaveLength(1);
      expect(
        slackReactions.filter((r) => r.method === "reactions.remove")
      ).toHaveLength(0);
    } finally {
      await msgIntrospector.dispose();
    }
  });
});
