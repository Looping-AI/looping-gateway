import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { handleSlackEvent } from "../src/slack-webhook-handler";
import { slackHeaders } from "./helpers/slack";

type FakeEnv = Pick<
  Env,
  "SLACK_SIGNING_SECRET" | "MESSAGE_WORKFLOW" | "LIFECYCLE_WORKFLOW"
>;

function makeEnv(overrides: Partial<FakeEnv> = {}): FakeEnv {
  return {
    SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET,
    MESSAGE_WORKFLOW: { create: vi.fn() } as unknown as Workflow,
    LIFECYCLE_WORKFLOW: { create: vi.fn() } as unknown as Workflow,
    ...overrides
  };
}

async function post(
  body: string,
  fakeEnv: FakeEnv,
  headers?: Record<string, string>
) {
  return handleSlackEvent(
    new Request("https://example.com/slack/events", {
      method: "POST",
      headers: headers ?? (await slackHeaders(body)),
      body
    }),
    fakeEnv
  );
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

  it("routes message_changed edits to the Lifecycle Workflow", async () => {
    const create = vi.fn();
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvEdit",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        channel_type: "channel"
      }
    });
    const res = await post(
      body,
      makeEnv({ LIFECYCLE_WORKFLOW: { create } as unknown as Workflow })
    );
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ subtype: "message_changed" })
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Ignored events
// ---------------------------------------------------------------------------

describe("ignored events", () => {
  it("acks 200 and calls no workflow for a bare channel message", async () => {
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
    expect(message).not.toHaveBeenCalled();
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

  it("returns 500 on an unexpected Workflow failure so Slack retries", async () => {
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
    expect(res.status).toBe(500);
  });
});
