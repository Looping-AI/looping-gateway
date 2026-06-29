import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getDb } from "@/db/client";
import { setWorkspaceAdminChannel } from "@/db/models/workspaces";
import { handleSlackEvent } from "@/slack-webhook-handler";
import { PENDING_REACTION } from "@/workflows/reaction";
import { stubSlack } from "../wrappers/slack-stub";
import { slackHeaders } from "../helpers/slack";

const db = getDb(env);

beforeEach(async () => {
  await setWorkspaceAdminChannel(db, 0, "C_ORGADMIN");
});

afterEach(() => vi.unstubAllGlobals());

interface PostCall {
  channel: string;
  thread_ts?: string;
  text: string;
}

function captureSlack(): PostCall[] {
  const calls: PostCall[] = [];
  stubSlack((method, body) => {
    if (method === "chat.postMessage") {
      calls.push({
        channel: body.get("channel") ?? "",
        thread_ts: body.get("thread_ts") ?? undefined,
        text: body.get("text") ?? ""
      });
    }
    return { ok: true, ts: "1700.2" };
  });
  return calls;
}

let seq = 0;
function makeAppMentionRequest(channelId: string, text: string) {
  const eventId = `Ev-wf-${++seq}`;
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

function makeDmRequest(channelId: string, text: string) {
  const eventId = `Ev-wf-${++seq}`;
  const body = JSON.stringify({
    type: "event_callback",
    event_id: eventId,
    team_id: "T1",
    event: {
      type: "message",
      channel_type: "im",
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
    env,
    ctx
  );
  await Promise.allSettled(waitUntilPromises);
  return res;
}

describe("MessageWorkflow (introspectWorkflow)", () => {
  it("admin-channel mention: resolve → dispatch → reply steps complete, channel-level reply posted", async () => {
    const calls = captureSlack();
    const introspector = await introspectWorkflow(env.MESSAGE_WORKFLOW);
    try {
      const { body } = makeAppMentionRequest("C_ORGADMIN", "<@UBOT> hello");
      const res = await trigger(body);
      expect(res.status).toBe(200);

      const [instance] = introspector.get();
      await instance.waitForStatus("complete");

      // The admin agent now runs the real AI loop (Workers AI). That binding is
      // unavailable offline, so the executor's graceful fallback posts instead —
      // either way this asserts the plumbing: Workflow → A2A → AdminAgent DO
      // (Session over SQLite) → channel-level reply. The AI text itself is covered
      // by the executor unit test and the manual e2e.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ channel: "C_ORGADMIN" });
      expect(calls[0].thread_ts).toBeUndefined();
      expect(calls[0].text.length).toBeGreaterThan(0);
    } finally {
      await introspector.dispose();
    }
  });

  it("DM: resolve → dispatch → reply steps complete, channel-level reply posted", async () => {
    const calls = captureSlack();
    const introspector = await introspectWorkflow(env.MESSAGE_WORKFLOW);
    try {
      const { body } = makeDmRequest("D1", "hey there");
      const res = await trigger(body);
      expect(res.status).toBe(200);

      const [instance] = introspector.get();
      await instance.waitForStatus("complete");

      // The onboarding concierge now runs the real AI loop (Workers AI), keyed to
      // a per-user DO instance. That binding is unavailable offline, so the
      // executor's graceful fallback posts instead — either way this asserts the
      // plumbing: Workflow → A2A → OnboardingAgent DO (Session over SQLite) →
      // channel-level reply (no thread). The AI text is covered by the executor
      // unit test and the manual e2e.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ channel: "D1" });
      expect(calls[0].thread_ts).toBeUndefined();
      expect(calls[0].text.length).toBeGreaterThan(0);
    } finally {
      await introspector.dispose();
    }
  });

  it("no-match channel: no agent woken, no workflow created, nothing posted", async () => {
    const calls = captureSlack();
    const introspector = await introspectWorkflow(env.MESSAGE_WORKFLOW);
    try {
      const { body } = makeAppMentionRequest(
        "C_UNCONFIGURED",
        "<@UBOT> anyone?"
      );
      const res = await trigger(body);
      expect(res.status).toBe(200);

      // Gate skips the workflow entirely when no agent resolves — no flicker.
      expect(introspector.get()).toHaveLength(0);
      expect(calls).toHaveLength(0);
    } finally {
      await introspector.dispose();
    }
  });
});

interface ReactionCall {
  method: string;
  channel: string;
  timestamp: string;
  name: string;
}

/** Capture replies and reaction calls together; all Slack calls resolve ok. */
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

describe("parallel ReactionWorkflow (via webhook handler)", () => {
  it("adds ⏳ on the trigger message and collects it after the reply is posted", async () => {
    const { reactions } = captureSlackWithReactions();
    const msgIntrospector = await introspectWorkflow(env.MESSAGE_WORKFLOW);
    const reactionIntrospector = await introspectWorkflow(
      env.REACTION_WORKFLOW
    );
    try {
      const { body } = makeAppMentionRequest("C_ORGADMIN", "<@UBOT> hello");
      const res = await trigger(body);
      expect(res.status).toBe(200);

      // The handler adds the ⏳ reaction inline and creates the removal workflow
      // in parallel with the message one.
      const [reaction] = reactionIntrospector.get();
      expect(reaction).toBeDefined();

      // The MessageWorkflow's collect-reaction step sends the real `reply_posted`
      // event, which resolves the reaction workflow's wait and triggers removal.
      const [msg] = msgIntrospector.get();
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
