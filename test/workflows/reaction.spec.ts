import { afterEach, describe, it, expect, vi } from "vitest";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  PENDING_REACTION,
  REACTION_COLLECT_EVENT,
  reactionInstanceId
} from "@/workflows/reaction";
import type { ReactionWorkflowParams } from "@/slack/types";
import { stubSlack } from "../wrappers/slack-stub";

afterEach(() => vi.unstubAllGlobals());

interface ReactionCall {
  method: string;
  channel: string;
  timestamp: string;
  name: string;
}

/** Record every reactions.add/remove call; all Slack calls resolve ok. */
function captureReactions(): ReactionCall[] {
  const calls: ReactionCall[] = [];
  stubSlack((method, body) => {
    if (method === "reactions.add" || method === "reactions.remove") {
      calls.push({
        method,
        channel: body.get("channel") ?? "",
        timestamp: body.get("timestamp") ?? "",
        name: body.get("name") ?? ""
      });
    }
    return { ok: true };
  });
  return calls;
}

let seq = 0;
function makeParams(): ReactionWorkflowParams {
  return { eventId: `Ev-react-${++seq}`, channelId: "C1", ts: "1700.1" };
}

describe("ReactionWorkflow", () => {
  it("adds the pending reaction, then collects it when the signal arrives", async () => {
    const calls = captureReactions();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      // Resolve the waitForEvent as if the MessageWorkflow signaled a posted reply.
      await introspector.modifyAll(async (m) => {
        await m.mockEvent({ type: REACTION_COLLECT_EVENT, payload: {} });
      });

      const p = makeParams();
      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });

      const [instance] = introspector.get();
      await instance.waitForStatus("complete");

      expect(calls.map((c) => c.method)).toEqual([
        "reactions.add",
        "reactions.remove"
      ]);
      expect(calls[0]).toMatchObject({
        channel: "C1",
        timestamp: "1700.1",
        name: PENDING_REACTION
      });
      expect(calls[1]).toMatchObject({
        channel: "C1",
        timestamp: "1700.1",
        name: PENDING_REACTION
      });
    } finally {
      await introspector.dispose();
    }
  });

  it("removes the reaction on the timeout backstop when no signal ever arrives", async () => {
    const calls = captureReactions();
    const introspector = await introspectWorkflow(env.REACTION_WORKFLOW);
    try {
      // Simulate a MessageWorkflow crash: the collect signal never comes, so the
      // wait times out and the backstop must still remove the reaction.
      await introspector.modifyAll(async (m) => {
        await m.forceEventTimeout({ name: "await collect signal" });
      });

      const p = makeParams();
      await env.REACTION_WORKFLOW.create({
        id: reactionInstanceId(p.eventId),
        params: p
      });

      const [instance] = introspector.get();
      await instance.waitForStatus("complete");

      expect(calls.map((c) => c.method)).toEqual([
        "reactions.add",
        "reactions.remove"
      ]);
    } finally {
      await introspector.dispose();
    }
  });
});
