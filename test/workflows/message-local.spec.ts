import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { setWorkspaceAdminChannel } from "@/db/models/workspaces";
import { handleSlackEvent } from "@/slack-webhook-handler";
import { AGENT_UNREACHABLE_TEXT } from "@/workflows/message-helpers";
import { stubSlack } from "../wrappers/slack-stub";
import { slackHeaders } from "../helpers/slack";

// Tests covering LocalMessageWorkflow execution paths (message-local.ts):
//   resolve → dispatch → reply     (admin channel, DM)
//   unreachable notice              (dispatch retries exhausted)
//   internal_error path             (Slack post retries exhausted)

beforeEach(async () => {
  await setWorkspaceAdminChannel(0, "C_ORGADMIN");
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
  const eventId = `Ev-local-${++seq}`;
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
  const eventId = `Ev-local-${++seq}`;
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
    ctx
  );
  await Promise.allSettled(waitUntilPromises);
  return res;
}

describe("LocalMessageWorkflow", () => {
  it("admin-channel mention: resolve → dispatch → reply steps complete, channel-level reply posted", async () => {
    const calls = captureSlack();
    const introspector = await introspectWorkflow(env.LOCAL_MESSAGE_WORKFLOW);
    try {
      const { body } = makeAppMentionRequest("C_ORGADMIN", "<@UBOT> hello");
      const res = await trigger(body);
      expect(res.status).toBe(200);

      const [instance] = await introspector.get();
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
    const introspector = await introspectWorkflow(env.LOCAL_MESSAGE_WORKFLOW);
    try {
      const { body } = makeDmRequest("D1", "hey there");
      const res = await trigger(body);
      expect(res.status).toBe(200);

      const [instance] = await introspector.get();
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

  it("posts an unreachable notice when a dispatch's retries are exhausted", async () => {
    const calls = captureSlack();
    const introspector = await introspectWorkflow(env.LOCAL_MESSAGE_WORKFLOW);
    try {
      // Force the admin dispatch to fail on every attempt (a persistent failure,
      // e.g. connection refused), with retry backoff disabled so we don't wait.
      await introspector.modifyAll(async (m) => {
        await m.disableRetryDelays([{ name: "dispatch:admin" }]);
        await m.mockStepError(
          { name: "dispatch:admin" },
          new Error("connection refused")
        );
      });

      const { body } = makeAppMentionRequest("C_ORGADMIN", "<@UBOT> hello");
      const res = await trigger(body);
      expect(res.status).toBe(200);

      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // Instead of silently clearing the ⏳, the user is told the agent couldn't
      // be reached — posted under the agent's identity in the same channel.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        channel: "C_ORGADMIN",
        text: AGENT_UNREACHABLE_TEXT
      });
    } finally {
      await introspector.dispose();
    }
  });

  it("a failed reply post is NOT reported as unreachable", async () => {
    const calls = captureSlack();
    const introspector = await introspectWorkflow(env.LOCAL_MESSAGE_WORKFLOW);
    try {
      // The agent replies fine, but posting it to Slack exhausts retries. This is
      // an internal-error, not a dispatch failure — the user must not be told the
      // agent "couldn't be reached" (and the run must still complete cleanly).
      await introspector.modifyAll(async (m) => {
        await m.disableRetryDelays([{ name: "reply:admin" }]);
        await m.mockStepError({ name: "reply:admin" }, new Error("slack 503"));
      });

      const { body } = makeAppMentionRequest("C_ORGADMIN", "<@UBOT> hello");
      const res = await trigger(body);
      expect(res.status).toBe(200);

      const [instance] = await introspector.get();
      await instance.waitForStatus("complete");

      // No unreachable notice, and nothing else posted (the only post — the reply —
      // is the step we forced to fail).
      expect(calls.map((c) => c.text)).not.toContain(AGENT_UNREACHABLE_TEXT);
      expect(calls).toHaveLength(0);
    } finally {
      await introspector.dispose();
    }
  });
});
