import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  handleSlackEvent,
  _resetAnchorCacheForTest,
  _resetPublicUrlCacheForTest
} from "../src/slack-webhook-handler";
import { slackHeaders } from "./helpers/slack";
import { getDb } from "@/db/client";
import {
  getConfig,
  setConfig,
  SystemConfigKeys
} from "@/db/models/workspace-configs";
import { ORG_WORKSPACE_ID } from "@/db/models/workspaces";
import { PENDING_REACTION } from "@/workflows/reaction";
import { stubSlack } from "./wrappers/slack-stub";

// The handler adds the ⏳ reaction inline via a real Slack API call, so every
// test needs global fetch stubbed. Tests that assert on the reaction re-stub
// with a capturing handler; this default keeps the rest benign.
beforeEach(() => stubSlack(() => ({ ok: true })));
afterEach(() => vi.unstubAllGlobals());

type FakeEnv = Pick<
  Env,
  | "DB"
  | "SLACK_SIGNING_SECRET"
  | "SLACK_BOT_TOKEN"
  | "MESSAGE_WORKFLOW"
  | "LIFECYCLE_WORKFLOW"
  | "REACTION_WORKFLOW"
>;

function makeEnv(overrides: Partial<FakeEnv> = {}): FakeEnv {
  return {
    DB: env.DB,
    SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET,
    SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
    MESSAGE_WORKFLOW: { create: vi.fn() } as unknown as Workflow,
    LIFECYCLE_WORKFLOW: { create: vi.fn() } as unknown as Workflow,
    REACTION_WORKFLOW: { create: vi.fn() } as unknown as Workflow,
    ...overrides
  };
}

async function post(
  body: string,
  fakeEnv: FakeEnv,
  headers?: Record<string, string>
) {
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
      headers: headers ?? (await slackHeaders(body)),
      body
    }),
    fakeEnv,
    ctx
  );
  await Promise.allSettled(waitUntilPromises);
  return res;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

describe("verification", () => {
  it("rejects a missing / wrong signature with 401", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const bad = await slackHeaders(body, "wrong-secret");
    const res = await post(body, makeEnv(), bad);
    expect(res.status).toBe(401);
  });

  it("rejects missing signature headers with 401", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const res = await post(body, makeEnv(), {
      "Content-Type": "application/json"
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// url_verification challenge
// ---------------------------------------------------------------------------

describe("url_verification", () => {
  it("echoes the challenge", async () => {
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "abc123"
    });
    const res = await post(body, makeEnv());
    expect(res.status).toBe(200);
    const json: { challenge: string } = await res.json();
    expect(json.challenge).toBe("abc123");
  });
});

// ---------------------------------------------------------------------------
// Message Workflow — app_mention and DM
// ---------------------------------------------------------------------------

describe("message events", () => {
  it("triggers the Message Workflow for an app_mention, keyed by event_id", async () => {
    const create = vi.fn();
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvMention",
      team_id: "T1",
      event: {
        type: "app_mention",
        user: "U1",
        text: "<@UBOT> hi",
        ts: "1700000000.000100",
        channel: "C1"
      }
    });
    const res = await post(
      body,
      makeEnv({ MESSAGE_WORKFLOW: { create } as unknown as Workflow })
    );
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      id: "EvMention",
      params: expect.objectContaining({
        eventId: "EvMention",
        eventType: "app_mention",
        channelId: "C1",
        userId: "U1"
      })
    });
  });

  it("triggers the Message Workflow for a direct message", async () => {
    const create = vi.fn();
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvDm",
      event: {
        type: "message",
        channel_type: "im",
        user: "U2",
        text: "hey",
        ts: "1700000000.000200",
        channel: "D1"
      }
    });
    const res = await post(
      body,
      makeEnv({ MESSAGE_WORKFLOW: { create } as unknown as Workflow })
    );
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "EvDm" })
    );
  });

  it("ignores a bot's own DM (no workflow triggered)", async () => {
    const create = vi.fn();
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvBot",
      event: {
        type: "message",
        channel_type: "im",
        bot_id: "B1",
        text: "I am a bot",
        ts: "1700000000.000300",
        channel: "D1"
      }
    });
    const res = await post(
      body,
      makeEnv({ MESSAGE_WORKFLOW: { create } as unknown as Workflow })
    );
    expect(res.status).toBe(200);
    expect(create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Parallel Reaction Workflow — ⏳ on the trigger message
// ---------------------------------------------------------------------------

interface ReactionAddCall {
  channel: string;
  timestamp: string;
  name: string;
}

/**
 * Capture reactions.add calls. By default all Slack calls resolve ok; pass a
 * `respond` to simulate failures (e.g. missing_scope).
 */
function captureAddReactions(
  respond: () => unknown = () => ({ ok: true })
): ReactionAddCall[] {
  const calls: ReactionAddCall[] = [];
  stubSlack((method, body) => {
    if (method === "reactions.add") {
      calls.push({
        channel: body.get("channel") ?? "",
        timestamp: body.get("timestamp") ?? "",
        name: body.get("name") ?? ""
      });
    }
    return respond();
  });
  return calls;
}

describe("reaction workflow", () => {
  it("adds the ⏳ reaction inline and starts the removal workflow", async () => {
    const reactionCreate = vi.fn();
    const adds = captureAddReactions();
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvReact",
      team_id: "T1",
      event: {
        type: "app_mention",
        user: "U1",
        text: "<@UBOT> hi",
        ts: "1700000000.000100",
        channel: "C1"
      }
    });
    const res = await post(
      body,
      makeEnv({
        REACTION_WORKFLOW: { create: reactionCreate } as unknown as Workflow
      })
    );
    expect(res.status).toBe(200);

    // The ⏳ reaction is added inline on the trigger message (not by the workflow).
    expect(adds).toEqual([
      {
        channel: "C1",
        timestamp: "1700000000.000100",
        name: PENDING_REACTION
      }
    ]);

    // The removal workflow is started, keyed by the trigger message.
    expect(reactionCreate).toHaveBeenCalledOnce();
    expect(reactionCreate).toHaveBeenCalledWith({
      id: "react-EvReact",
      params: {
        eventId: "EvReact",
        channelId: "C1",
        ts: "1700000000.000100"
      }
    });
  });

  it("still acks 200 when adding the reaction fails (best-effort)", async () => {
    const messageCreate = vi.fn();
    captureAddReactions(() => ({ ok: false, error: "missing_scope" }));
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvReactAddFail",
      team_id: "T1",
      event: {
        type: "app_mention",
        user: "U1",
        text: "<@UBOT> hi",
        ts: "1700000000.000100",
        channel: "C1"
      }
    });
    const res = await post(
      body,
      makeEnv({
        MESSAGE_WORKFLOW: { create: messageCreate } as unknown as Workflow
      })
    );
    expect(res.status).toBe(200);
    // The message workflow is authoritative and still runs.
    expect(messageCreate).toHaveBeenCalledOnce();
  });

  it("still acks 200 when starting the removal workflow fails (best-effort)", async () => {
    const messageCreate = vi.fn();
    const reactionCreate = vi.fn(() => {
      throw new Error("reaction boom");
    });
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvReactFail",
      team_id: "T1",
      event: {
        type: "app_mention",
        user: "U1",
        text: "<@UBOT> hi",
        ts: "1700000000.000100",
        channel: "C1"
      }
    });
    const res = await post(
      body,
      makeEnv({
        MESSAGE_WORKFLOW: { create: messageCreate } as unknown as Workflow,
        REACTION_WORKFLOW: { create: reactionCreate } as unknown as Workflow
      })
    );
    expect(res.status).toBe(200);
    // The message workflow is authoritative and still runs.
    expect(messageCreate).toHaveBeenCalledOnce();
  });

  it("does not react or start a removal workflow for lifecycle events", async () => {
    const reactionCreate = vi.fn();
    const adds = captureAddReactions();
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvJoinNoReact",
      team_id: "T1",
      event: { type: "member_joined_channel", user: "U2", channel: "C1" }
    });
    const res = await post(
      body,
      makeEnv({
        REACTION_WORKFLOW: { create: reactionCreate } as unknown as Workflow
      })
    );
    expect(res.status).toBe(200);
    expect(adds).toEqual([]);
    expect(reactionCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle Workflow
// ---------------------------------------------------------------------------

describe("lifecycle events", () => {
  it("triggers the Lifecycle Workflow for member_joined_channel", async () => {
    const create = vi.fn();
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvJoin",
      team_id: "T1",
      event: { type: "member_joined_channel", user: "U2", channel: "C1" }
    });
    const res = await post(
      body,
      makeEnv({ LIFECYCLE_WORKFLOW: { create } as unknown as Workflow })
    );
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      id: "EvJoin",
      params: expect.objectContaining({ type: "member_joined_channel" })
    });
  });

  it("triggers the Lifecycle Workflow for member_left_channel", async () => {
    const create = vi.fn();
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvLeft",
      event: { type: "member_left_channel", user: "U2", channel: "C1" }
    });
    const res = await post(
      body,
      makeEnv({ LIFECYCLE_WORKFLOW: { create } as unknown as Workflow })
    );
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledOnce();
  });

  it("triggers the Lifecycle Workflow for team_join", async () => {
    const create = vi.fn();
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvTeam",
      team_id: "T1",
      event: { type: "team_join", user: { id: "U9", name: "newbie" } }
    });
    const res = await post(
      body,
      makeEnv({ LIFECYCLE_WORKFLOW: { create } as unknown as Workflow })
    );
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          type: "team_join",
          userId: "U9",
          displayName: "newbie"
        })
      })
    );
  });

  it("routes message_changed edits to the Message Workflow", async () => {
    const create = vi.fn();
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvEdit",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        channel_type: "channel",
        message: { ts: "1700000000.1", user: "U1", text: "new" },
        previous_message: { ts: "1700000000.1", user: "U1", text: "old" }
      }
    });
    const res = await post(
      body,
      makeEnv({ MESSAGE_WORKFLOW: { create } as unknown as Workflow })
    );
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ editKind: "edited", text: "new" })
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Ignored events
// ---------------------------------------------------------------------------

describe("ignored events", () => {
  it("routes a bare channel message to the Message Workflow", async () => {
    const message = vi.fn();
    const lifecycle = vi.fn();
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvCh",
      event: {
        type: "message",
        channel_type: "channel",
        user: "U1",
        text: "hello",
        channel: "C1",
        ts: "1700000000.1"
      }
    });
    const res = await post(
      body,
      makeEnv({
        MESSAGE_WORKFLOW: { create: message } as unknown as Workflow,
        LIFECYCLE_WORKFLOW: { create: lifecycle } as unknown as Workflow
      })
    );
    expect(res.status).toBe(200);
    expect(message).toHaveBeenCalledOnce();
    expect(lifecycle).not.toHaveBeenCalled();
  });

  it("acks 200 for a slash command", async () => {
    const body = "command=%2Ffoo&channel_id=C1&user_id=U1&team_id=T1&text=bar";
    const res = await post(body, makeEnv(), {
      ...(await slackHeaders(body)),
      "Content-Type": "application/x-www-form-urlencoded"
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Retry dedupe and error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  it("acks 200 when the workflow instance already exists (Slack retry)", async () => {
    const create = vi
      .fn()
      .mockRejectedValue(
        new Error("instance with id EvMention already exists")
      );
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvMention",
      event: {
        type: "app_mention",
        user: "U1",
        text: "hi",
        ts: "1.1",
        channel: "C1"
      }
    });
    const res = await post(
      body,
      makeEnv({ MESSAGE_WORKFLOW: { create } as unknown as Workflow })
    );
    expect(res.status).toBe(200);
  });

  it("still returns 200 on an unexpected Workflow failure (error is logged, Slack does not retry)", async () => {
    const create = vi
      .fn()
      .mockRejectedValue(new Error("transient network error"));
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvBoom",
      event: {
        type: "app_mention",
        user: "U1",
        text: "hi",
        ts: "1.1",
        channel: "C1"
      }
    });
    const res = await post(
      body,
      makeEnv({ MESSAGE_WORKFLOW: { create } as unknown as Workflow })
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Team-id guard
// ---------------------------------------------------------------------------

describe("team guard", () => {
  const db = getDb(env);

  afterEach(() => {
    // D1 is reset before each test (apply-migrations.ts); only the
    // isolate-level memo needs manual clearing.
    _resetAnchorCacheForTest();
  });

  it("passes through when no anchor is stored (bootstrap grace window)", async () => {
    // No anchor set — first event ever should be allowed.
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvGrace",
      team_id: "T_ANY",
      event: {
        type: "app_mention",
        user: "U1",
        text: "hi",
        ts: "1.1",
        channel: "C1"
      }
    });
    const res = await post(body, makeEnv());
    expect(res.status).toBe(200);
  });

  it("passes through when event team_id matches the pinned anchor", async () => {
    await setConfig(
      db,
      ORG_WORKSPACE_ID,
      SystemConfigKeys.SLACK_TEAM_ID,
      "T_MATCH"
    );
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvMatch",
      team_id: "T_MATCH",
      event: {
        type: "app_mention",
        user: "U1",
        text: "hi",
        ts: "1.1",
        channel: "C1"
      }
    });
    const res = await post(body, makeEnv());
    expect(res.status).toBe(200);
  });

  it("returns 403 when event team_id mismatches the pinned anchor", async () => {
    await setConfig(
      db,
      ORG_WORKSPACE_ID,
      SystemConfigKeys.SLACK_TEAM_ID,
      "T_RIGHT"
    );
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvBad",
      team_id: "T_WRONG",
      event: {
        type: "app_mention",
        user: "U1",
        text: "hi",
        ts: "1.1",
        channel: "C1"
      }
    });
    const res = await post(body, makeEnv());
    expect(res.status).toBe(403);
  });

  it("blocks lifecycle events with mismatching team_id", async () => {
    await setConfig(
      db,
      ORG_WORKSPACE_ID,
      SystemConfigKeys.SLACK_TEAM_ID,
      "T_RIGHT"
    );
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvBadLifecycle",
      team_id: "T_WRONG",
      event: { type: "member_joined_channel", user: "U2", channel: "C1" }
    });
    const res = await post(body, makeEnv());
    expect(res.status).toBe(403);
  });

  it("passes through when the event carries no team_id (skip-check path)", async () => {
    // Anchor is pinned but event has no team_id — should still pass (Q6).
    await setConfig(
      db,
      ORG_WORKSPACE_ID,
      SystemConfigKeys.SLACK_TEAM_ID,
      "T_RIGHT"
    );
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvNoTeam",
      // no team_id field at the envelope level
      event: { type: "member_left_channel", user: "U2", channel: "C1" }
    });
    const res = await post(body, makeEnv());
    expect(res.status).toBe(200);
  });

  it("url_verification challenge is never blocked by the team guard", async () => {
    await setConfig(
      db,
      ORG_WORKSPACE_ID,
      SystemConfigKeys.SLACK_TEAM_ID,
      "T_RIGHT"
    );
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "abc_guard"
    });
    const res = await post(body, makeEnv());
    expect(res.status).toBe(200);
    const json: { challenge: string } = await res.json();
    expect(json.challenge).toBe("abc_guard");
  });
});

// ---------------------------------------------------------------------------
// Public-URL discovery — the JWT issuer/jku anchor is recorded only AFTER the
// Slack signature is verified, so an unauthenticated caller can't poison it.
// ---------------------------------------------------------------------------

describe("public url discovery", () => {
  const db = getDb(env);

  afterEach(() => {
    _resetPublicUrlCacheForTest();
  });

  it("persists the gateway public origin after a verified request", async () => {
    _resetPublicUrlCacheForTest();
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const res = await post(body, makeEnv());
    expect(res.status).toBe(200);
    expect(
      await getConfig(db, ORG_WORKSPACE_ID, SystemConfigKeys.PUBLIC_URL)
    ).toBe("https://example.com");
  });

  it("does NOT persist the origin when the signature is invalid", async () => {
    _resetPublicUrlCacheForTest();
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const bad = await slackHeaders(body, "wrong-secret");
    const res = await post(body, makeEnv(), bad);
    expect(res.status).toBe(401);
    expect(
      await getConfig(db, ORG_WORKSPACE_ID, SystemConfigKeys.PUBLIC_URL)
    ).toBeNull();
  });
});
