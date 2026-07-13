import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  handleSlackEvent,
  _resetAnchorCacheForTest,
  _resetPublicUrlCacheForTest
} from "../src/slack-webhook-handler";
import { slackHeaders } from "./helpers/slack";
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Spy on a workflow binding's `create`, resolving to a throwaway instance.
// Returns the spy so tests can assert on it. Because the handler now reads the
// workflow bindings off the global `env`, the spy replaces the real create.
function spyWorkflow(
  binding: "MESSAGE_WORKFLOW" | "REACTION_WORKFLOW" | "LIFECYCLE_WORKFLOW"
) {
  return vi
    .spyOn(env[binding], "create")
    .mockResolvedValue({} as WorkflowInstance);
}

// A channel_messages agent on C1 so the handler's target gate resolves ≥1 agent
// and still fires the message/reaction workflows (app_mention, edits, plain msgs).
beforeEach(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO agents (name, kind, enabled, notify_on, a2a_endpoint, workspace_id) VALUES ('wf-c1', 'custom', 1, 'channel_messages', 'https://example.com/wf-c1', 0)"
  ).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO agent_channels (channel_id, agent_name) VALUES ('C1', 'wf-c1')"
  ).run();
});

async function post(body: string, headers?: Record<string, string>) {
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
    const res = await post(body, bad);
    expect(res.status).toBe(401);
  });

  it("rejects missing signature headers with 401", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const res = await post(body, {
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
    const res = await post(body);
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
    const create = spyWorkflow("MESSAGE_WORKFLOW");
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
    const res = await post(body);
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
    const create = spyWorkflow("MESSAGE_WORKFLOW");
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
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "EvDm" })
    );
  });

  it("ignores a bot's own DM (no workflow triggered)", async () => {
    const create = spyWorkflow("MESSAGE_WORKFLOW");
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
    const res = await post(body);
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
    const reactionCreate = spyWorkflow("REACTION_WORKFLOW");
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
    const res = await post(body);
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
    const messageCreate = spyWorkflow("MESSAGE_WORKFLOW");
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
    const res = await post(body);
    expect(res.status).toBe(200);
    // The message workflow is authoritative and still runs.
    expect(messageCreate).toHaveBeenCalledOnce();
  });

  it("still acks 200 when starting the removal workflow fails (best-effort)", async () => {
    const messageCreate = spyWorkflow("MESSAGE_WORKFLOW");
    const reactionCreate = vi
      .spyOn(env.REACTION_WORKFLOW, "create")
      .mockImplementation(() => {
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
    const res = await post(body);
    expect(res.status).toBe(200);
    // The message workflow is authoritative and still runs.
    expect(messageCreate).toHaveBeenCalledOnce();
    expect(reactionCreate).toHaveBeenCalledOnce();
  });

  it("does not react or start a removal workflow for lifecycle events", async () => {
    const reactionCreate = spyWorkflow("REACTION_WORKFLOW");
    const adds = captureAddReactions();
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvJoinNoReact",
      team_id: "T1",
      event: { type: "member_joined_channel", user: "U2", channel: "C1" }
    });
    const res = await post(body);
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
    const create = spyWorkflow("LIFECYCLE_WORKFLOW");
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvJoin",
      team_id: "T1",
      event: { type: "member_joined_channel", user: "U2", channel: "C1" }
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      id: "EvJoin",
      params: expect.objectContaining({ type: "member_joined_channel" })
    });
  });

  it("triggers the Lifecycle Workflow for member_left_channel", async () => {
    const create = spyWorkflow("LIFECYCLE_WORKFLOW");
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvLeft",
      event: { type: "member_left_channel", user: "U2", channel: "C1" }
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledOnce();
  });

  it("triggers the Lifecycle Workflow for team_join", async () => {
    const create = spyWorkflow("LIFECYCLE_WORKFLOW");
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvTeam",
      team_id: "T1",
      event: { type: "team_join", user: { id: "U9", name: "newbie" } }
    });
    const res = await post(body);
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
    const create = spyWorkflow("MESSAGE_WORKFLOW");
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
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ editKind: "edited", text: "new" })
      })
    );
  });

  it("ignores a message_changed whose text is unchanged (metadata-only, e.g. link unfurl)", async () => {
    const create = spyWorkflow("MESSAGE_WORKFLOW");
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvEditNoOp",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        channel_type: "channel",
        message: { ts: "1700000000.1", user: "U1", text: "see github.com/x" },
        previous_message: {
          ts: "1700000000.1",
          user: "U1",
          text: "see github.com/x"
        }
      }
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(create).not.toHaveBeenCalled();
  });

  it("ignores a message_changed that differs only in whitespace", async () => {
    const create = spyWorkflow("MESSAGE_WORKFLOW");
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvEditWs",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        channel_type: "channel",
        message: { ts: "1700000000.1", user: "U1", text: "hello  world " },
        previous_message: {
          ts: "1700000000.1",
          user: "U1",
          text: "hello world"
        }
      }
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(create).not.toHaveBeenCalled();
  });

  it("extracts userId from message.edited.user when message.user is absent (channel message_changed)", async () => {
    const create = spyWorkflow("MESSAGE_WORKFLOW");
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvEditedUser",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        channel_type: "channel",
        message: {
          ts: "1700000000.1",
          edited: { user: "U_EDITOR" },
          text: "new"
        },
        previous_message: { ts: "1700000000.1", text: "old" }
      }
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          userId: "U_EDITOR",
          editKind: "edited"
        })
      })
    );
  });

  it("ignores a channel message_deleted when no user id is available", async () => {
    const create = spyWorkflow("MESSAGE_WORKFLOW");
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvDelNoUser",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C1",
        channel_type: "channel",
        deleted_ts: "1700000000.1",
        previous_message: { ts: "1700000000.1", text: "gone" }
        // no user on previous_message
      }
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(create).not.toHaveBeenCalled();
  });

  it("ignores a DM message_changed when no user id is available", async () => {
    const create = spyWorkflow("MESSAGE_WORKFLOW");
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvDmEditNoUser",
      event: {
        type: "message",
        channel_type: "im",
        subtype: "message_changed",
        channel: "D1",
        message: { ts: "1700000000.1", text: "new" },
        previous_message: { ts: "1700000000.1", text: "old" }
        // no user anywhere
      }
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(create).not.toHaveBeenCalled();
  });

  it("ignores a DM message_deleted when no user id is available", async () => {
    const create = spyWorkflow("MESSAGE_WORKFLOW");
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvDmDelNoUser",
      event: {
        type: "message",
        channel_type: "im",
        subtype: "message_deleted",
        channel: "D1",
        deleted_ts: "1700000000.1",
        previous_message: { ts: "1700000000.1", text: "gone" }
        // no user on previous_message
      }
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(create).not.toHaveBeenCalled();
  });

  it("routes a DM message_deleted to the Message Workflow when user id is present", async () => {
    const create = spyWorkflow("MESSAGE_WORKFLOW");
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvDmDel",
      event: {
        type: "message",
        channel_type: "im",
        subtype: "message_deleted",
        channel: "D1",
        deleted_ts: "1700000000.1",
        previous_message: { ts: "1700000000.1", user: "U3", text: "gone" }
      }
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ userId: "U3", editKind: "deleted" })
      })
    );
  });

  it("wakes a mention-only agent when its name appears in prevText of a message_deleted", async () => {
    // Register a mention-only agent named "del-agent" on channel C1.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO agents (name, kind, enabled, notify_on, a2a_endpoint, workspace_id) VALUES ('del-agent', 'custom', 1, 'mention', 'https://example.com/del-agent', 0)"
    ).run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO agent_channels (channel_id, agent_name) VALUES ('C1', 'del-agent')"
    ).run();

    const create = spyWorkflow("MESSAGE_WORKFLOW");
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvChDel",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C1",
        channel_type: "channel",
        deleted_ts: "1700000000.1",
        previous_message: {
          ts: "1700000000.1",
          user: "U4",
          text: "hey @del-agent please check this"
        }
      }
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    // The mention-only agent must be woken even though base.text is empty.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ editKind: "deleted" })
      })
    );
  });

  it("does not wake a mention-only agent when its name appears in neither text nor prevText of a message_deleted", async () => {
    // Register a mention-only agent named "quiet-agent" on channel C1.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO agents (name, kind, enabled, notify_on, a2a_endpoint, workspace_id) VALUES ('quiet-agent', 'custom', 1, 'mention', 'https://example.com/quiet-agent', 0)"
    ).run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO agent_channels (channel_id, agent_name) VALUES ('C1', 'quiet-agent')"
    ).run();

    // Use a separate channel with only the mention-only agent (no channel_messages
    // agent) so the no-targets path is exercised cleanly.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO agent_channels (channel_id, agent_name) VALUES ('C_QUIET', 'quiet-agent')"
    ).run();

    const create = spyWorkflow("MESSAGE_WORKFLOW");
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvChDelNoMention",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C_QUIET",
        channel_type: "channel",
        deleted_ts: "1700000000.2",
        previous_message: {
          ts: "1700000000.2",
          user: "U4",
          text: "nothing relevant here"
        }
      }
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Ignored events
// ---------------------------------------------------------------------------

describe("ignored events", () => {
  it("routes a bare channel message to the Message Workflow", async () => {
    const message = spyWorkflow("MESSAGE_WORKFLOW");
    const lifecycle = spyWorkflow("LIFECYCLE_WORKFLOW");
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
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(message).toHaveBeenCalledOnce();
    expect(lifecycle).not.toHaveBeenCalled();
  });

  it("acks 200 for a slash command", async () => {
    const body = "command=%2Ffoo&channel_id=C1&user_id=U1&team_id=T1&text=bar";
    const res = await post(body, {
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
    vi.spyOn(env.MESSAGE_WORKFLOW, "create").mockRejectedValue(
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
    const res = await post(body);
    expect(res.status).toBe(200);
  });

  it("still returns 200 on an unexpected Workflow failure (error is logged, Slack does not retry)", async () => {
    vi.spyOn(env.MESSAGE_WORKFLOW, "create").mockRejectedValue(
      new Error("transient network error")
    );
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
    const res = await post(body);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Team-id guard
// ---------------------------------------------------------------------------

describe("team guard", () => {
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
    const res = await post(body);
    expect(res.status).toBe(200);
  });

  it("passes through when event team_id matches the pinned anchor", async () => {
    await setConfig(
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
    const res = await post(body);
    expect(res.status).toBe(200);
  });

  it("returns 403 when event team_id mismatches the pinned anchor", async () => {
    await setConfig(
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
    const res = await post(body);
    expect(res.status).toBe(403);
  });

  it("blocks lifecycle events with mismatching team_id", async () => {
    await setConfig(
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
    const res = await post(body);
    expect(res.status).toBe(403);
  });

  it("passes through when the event carries no team_id (skip-check path)", async () => {
    // Anchor is pinned but event has no team_id — should still pass (Q6).
    await setConfig(
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
    const res = await post(body);
    expect(res.status).toBe(200);
  });

  it("url_verification challenge is never blocked by the team guard", async () => {
    await setConfig(
      ORG_WORKSPACE_ID,
      SystemConfigKeys.SLACK_TEAM_ID,
      "T_RIGHT"
    );
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "abc_guard"
    });
    const res = await post(body);
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
  afterEach(() => {
    _resetPublicUrlCacheForTest();
  });

  it("persists the gateway public origin after a verified request", async () => {
    _resetPublicUrlCacheForTest();
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await getConfig(ORG_WORKSPACE_ID, SystemConfigKeys.PUBLIC_URL)).toBe(
      "https://example.com"
    );
  });

  it("does NOT persist the origin when the signature is invalid", async () => {
    _resetPublicUrlCacheForTest();
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const bad = await slackHeaders(body, "wrong-secret");
    const res = await post(body, bad);
    expect(res.status).toBe(401);
    expect(
      await getConfig(ORG_WORKSPACE_ID, SystemConfigKeys.PUBLIC_URL)
    ).toBeNull();
  });
});
