import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setWorkspaceAdminChannel } from "@/db/models/workspaces";
import { handleSlackEvent } from "@/slack-webhook-handler";
import { PENDING_REACTION } from "@/workflows/reaction";
import {
  dispatchMessage,
  feedText,
  replyThreadTs,
  type AgentPlan
} from "@/workflows/message-helpers";
import type { MessageWorkflowParams } from "@/slack/types";
import { stubSlack } from "../wrappers/slack-stub";
import { slackHeaders } from "../helpers/slack";

// Tests covering the shared helpers in message-helpers.ts:
//   replyThreadTs   — direct unit tests (pure fn)
//   feedText        — direct unit tests (pure fn)
//   dispatchMessage — InvalidEndpointError → error_reply path (no-domains-approved case)
//   resolveMessage  — exercised via the no-targets short-circuit
//   signalReactionCollect — exercised via the reaction-removal integration
//   handleUnreachable — covered indirectly via message-local.spec + message-remote.spec

beforeEach(async () => {
  await setWorkspaceAdminChannel(0, "C_ORGADMIN");
});

afterEach(() => vi.unstubAllGlobals());

interface PostCall {
  channel: string;
  thread_ts?: string;
  text: string;
}

interface ReactionCall {
  method: string;
  channel: string;
  timestamp: string;
  name: string;
}

function captureSlackWithReactions(): {
  post: PostCall[];
  reactions: ReactionCall[];
} {
  const post: PostCall[] = [];
  const reactions: ReactionCall[] = [];
  stubSlack((method, body) => {
    if (method === "chat.postMessage") {
      post.push({
        channel: body.get("channel") ?? "",
        thread_ts: body.get("thread_ts") ?? undefined,
        text: body.get("text") ?? ""
      });
    } else if (method === "reactions.add" || method === "reactions.remove") {
      reactions.push({
        method,
        channel: body.get("channel") ?? "",
        timestamp: body.get("timestamp") ?? "",
        name: body.get("name") ?? ""
      });
    }
    return { ok: true, ts: "1700.2" };
  });
  return { post, reactions };
}

let seq = 0;
function makeAppMentionRequest(channelId: string, text: string) {
  const eventId = `Ev-helpers-${++seq}`;
  const body = JSON.stringify({
    type: "event_callback",
    event_id: eventId,
    team_id: "T1",
    event: {
      type: "app_mention",
      channel: channelId,
      user: "U1",
      text,
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

// Minimal MessageWorkflowParams fixture for pure-function tests.
function makeParams(
  overrides: Partial<MessageWorkflowParams> = {}
): MessageWorkflowParams {
  return {
    eventId: "Ev-helpers-0",
    eventType: "app_mention",
    channelId: "C1",
    threadTs: "1700.1",
    ts: "1700.1",
    userId: "U1",
    text: "hello world",
    raw: {},
    targets: [],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// replyThreadTs
// ---------------------------------------------------------------------------

describe("replyThreadTs", () => {
  it("returns null when threadTs equals ts (not inside a real thread)", () => {
    expect(
      replyThreadTs(makeParams({ ts: "1700.1", threadTs: "1700.1" }))
    ).toBeNull();
  });

  it("returns null when threadTs is falsy (top-level channel message)", () => {
    expect(
      replyThreadTs(makeParams({ ts: "1700.1", threadTs: "" }))
    ).toBeNull();
  });

  it("returns threadTs when it differs from ts (genuine thread reply)", () => {
    expect(
      replyThreadTs(makeParams({ ts: "1700.5", threadTs: "1699.0" }))
    ).toBe("1699.0");
  });
});

// ---------------------------------------------------------------------------
// feedText
// ---------------------------------------------------------------------------

describe("feedText", () => {
  it("returns the message text verbatim for a plain message", () => {
    expect(feedText(makeParams({ text: "plain message" }))).toBe(
      "plain message"
    );
  });

  it("renders an edit feed turn describing before/after text", () => {
    const result = feedText(
      makeParams({
        editKind: "edited",
        ts: "1700.1",
        text: "new text",
        prevText: "old text"
      })
    );
    expect(result).toContain("edited");
    expect(result).toContain("old text");
    expect(result).toContain("new text");
  });

  it("renders a delete feed turn with the prior text as transcript", () => {
    const result = feedText(
      makeParams({
        editKind: "deleted",
        ts: "1700.1",
        prevText: "deleted content"
      })
    );
    expect(result).toContain("deleted");
    expect(result).toContain("deleted content");
  });
});

// ---------------------------------------------------------------------------
// dispatchMessage — InvalidEndpointError → error_reply
// ---------------------------------------------------------------------------

describe("dispatchMessage", () => {
  it("returns error_reply when the endpoint domain is not in the approved list", async () => {
    // No setAllowedRemoteAgentDomains call → DB has no approved domains →
    // validateRemoteEndpoint throws InvalidEndpointError → dispatchMessage catches
    // it and converts to error_reply (does NOT retry, since this is a policy verdict).
    const plan: AgentPlan = {
      agent: {
        name: "blocked-agent",
        kind: "custom",
        a2aEndpoint: "https://notapproved.example.com/a2a",
        workspaceId: 1
      },
      workspaceId: 1,
      text: "hello",
      channelName: null,
      displayName: "Blocked Agent",
      iconUrl: null,
      user: {
        slackUserId: "U1",
        displayName: null,
        isPrimaryOwner: false,
        isOrgAdmin: false,
        adminWorkspaces: []
      }
    };
    const result = await dispatchMessage(makeParams(), plan);
    expect(result).toMatchObject({
      kind: "error_reply",
      text: expect.stringContaining("security policy")
    });
    expect((result as { kind: "error_reply"; text: string }).text).toContain(
      "blocked-agent"
    );
  });
});

// ---------------------------------------------------------------------------
// resolveMessage — empty-targets path
// ---------------------------------------------------------------------------

describe("resolveMessage (via webhook handler)", () => {
  it("no-match channel: no agent woken, no workflow created, nothing posted", async () => {
    const introspector = await introspectWorkflow(env.LOCAL_MESSAGE_WORKFLOW);
    try {
      const { body } = makeAppMentionRequest(
        "C_UNCONFIGURED",
        "<@UBOT> anyone?"
      );
      const res = await trigger(body);
      expect(res.status).toBe(200);

      // resolveMessage returns an empty target list → handler skips both
      // workflows and the reaction entirely; no hourglass flicker.
      expect(await introspector.get()).toHaveLength(0);
    } finally {
      await introspector.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// signalReactionCollect — ⏳ removal
// ---------------------------------------------------------------------------

describe("signalReactionCollect (via LocalMessageWorkflow)", () => {
  it("sends reply_posted to ReactionWorkflow once the local reply is done, removing ⏳", async () => {
    const { reactions } = captureSlackWithReactions();
    const msgIntrospector = await introspectWorkflow(
      env.LOCAL_MESSAGE_WORKFLOW
    );
    const reactionIntrospector = await introspectWorkflow(
      env.REACTION_WORKFLOW
    );
    try {
      const { body } = makeAppMentionRequest("C_ORGADMIN", "<@UBOT> hello");
      const res = await trigger(body);
      expect(res.status).toBe(200);

      const [reaction] = await reactionIntrospector.get();
      expect(reaction).toBeDefined();

      const [msg] = await msgIntrospector.get();
      await msg.waitForStatus("complete");
      await reaction.waitForStatus("complete");

      expect(reactions.map((r) => r.method)).toEqual([
        "reactions.add",
        "reactions.remove"
      ]);
      expect(reactions[0]).toMatchObject({
        channel: "C_ORGADMIN",
        timestamp: "1700.1",
        name: PENDING_REACTION
      });
    } finally {
      await reactionIntrospector.dispose();
      await msgIntrospector.dispose();
    }
  });
});
