import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getDb } from "@/db/client";
import { setWorkspaceAdminChannel } from "@/db/models/workspaces";
import { handleSlackEvent } from "@/slack-webhook-handler";
import { NO_AGENT_HINT } from "@/workflows/message";
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
  return handleSlackEvent(
    new Request("https://example.com/slack/events", {
      method: "POST",
      headers: await slackHeaders(body),
      body
    }),
    env
  );
}

describe("MessageWorkflow (introspectWorkflow)", () => {
  it("admin-channel mention: resolve → dispatch → reply steps complete, threaded reply posted", async () => {
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
      // (Session over SQLite) → threaded reply. The AI text itself is covered by
      // the executor unit test and the manual e2e.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        channel: "C_ORGADMIN",
        thread_ts: "1700.1"
      });
      expect(calls[0].text.length).toBeGreaterThan(0);
    } finally {
      await introspector.dispose();
    }
  });

  it("DM: resolve → dispatch → reply steps complete, threaded reply (thread_ts = ts)", async () => {
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
      // threaded reply (thread_ts = ts). The AI text is covered by the executor
      // unit test and the manual e2e.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ channel: "D1" });
      expect(calls[0].text.length).toBeGreaterThan(0);
      expect(calls[0].thread_ts).toBe("1700.1");
    } finally {
      await introspector.dispose();
    }
  });

  it("no-match channel: resolve → hint steps complete, hint text posted", async () => {
    const calls = captureSlack();
    const introspector = await introspectWorkflow(env.MESSAGE_WORKFLOW);
    try {
      const { body } = makeAppMentionRequest(
        "C_UNCONFIGURED",
        "<@UBOT> anyone?"
      );
      const res = await trigger(body);
      expect(res.status).toBe(200);

      const [instance] = introspector.get();
      await instance.waitForStatus("complete");

      expect(calls).toHaveLength(1);
      expect(calls[0].text).toBe(NO_AGENT_HINT);
    } finally {
      await introspector.dispose();
    }
  });
});
