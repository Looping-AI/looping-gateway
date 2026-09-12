import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import {
  AgentCard,
  Message,
  SendMessageResponse,
  TaskState
} from "@a2a-js/sdk";
import { registerAgent } from "@/db/models/agents";
import {
  setPublicUrl,
  setAllowedRemoteAgentDomains
} from "@/db/models/workspace-configs";
import {
  createAgentTask,
  suspendForInput,
  getAgentTaskByToken
} from "@/db/models/agent-tasks";
import {
  createHitlRequest,
  setHitlSlackMessageTs,
  getHitlRequest
} from "@/db/models/hitl-requests";
import { _resetIssuerCacheForTest } from "@/agents/dispatch";
import { buildAgentCard } from "@/a2a/card";
import {
  SLACK_FREEFORM_ACTION_ID,
  SLACK_FREEFORM_BLOCK_ID,
  SLACK_FREEFORM_CALLBACK_ID
} from "@chat-adapter/slack/blocks";
import { MAX_MESSAGE_TEXT_BYTES } from "@dynamicagents/g2a-protocol";
import { HITL_RESPONSE_TYPE } from "@/a2a/hitl";
import { dataOf, partsText } from "@/a2a/parts";
import { agentMessage, makeTask } from "./helpers/a2a";
import { handleSlackInteractivity } from "@/slack-interactivity-handler";
import { slackHeaders } from "./helpers/slack";

const ENDPOINT = "https://remote.example.com/a2a";
const ISSUER = "https://gw.example.com";

interface Captured {
  slackUpdates: URLSearchParams[];
  slackEphemerals: URLSearchParams[];
  /** Plain `chat.postMessage` thread replies (e.g. the resume-failed notice). */
  slackReplies: URLSearchParams[];
  resumeMessages: Message[];
}

/**
 * Route Slack API calls and the remote A2A send to a single capturing stub. Pass
 * `rejectResume` to make the remote break the async contract (a sync message
 * reply instead of a Task ack), so the continuation is not accepted.
 */
function stub(captured: Captured, opts: { rejectResume?: boolean } = {}) {
  const card = buildAgentCard({
    name: "Remote",
    description: "remote agent",
    url: ENDPOINT
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = request.url;
      if (url.includes("chat.update")) {
        captured.slackUpdates.push(
          new URLSearchParams(await request.clone().text())
        );
        return Response.json({ ok: true, ts: "1700.9" });
      }
      if (url.includes("chat.postEphemeral")) {
        captured.slackEphemerals.push(
          new URLSearchParams(await request.clone().text())
        );
        return Response.json({ ok: true, message_ts: "1700.99" });
      }
      if (url.includes("chat.postMessage")) {
        captured.slackReplies.push(
          new URLSearchParams(await request.clone().text())
        );
        return Response.json({ ok: true, ts: "1700.98" });
      }
      // A2A: card discovery (GET) + SendMessage (POST).
      if (request.method.toUpperCase() === "POST") {
        const rpc = (await request.clone().json()) as {
          id?: unknown;
          params?: { message?: Message };
        };
        // The message arrives as protobuf-JSON; decode it so assertions run
        // against the same typed shape the gatekeeper sent.
        captured.resumeMessages.push(
          Message.fromJSON(rpc.params?.message ?? {})
        );
        if (opts.rejectResume) {
          // Sync reply instead of a Task ack → the gatekeeper treats it as a non-accept.
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id ?? 1,
            result: SendMessageResponse.toJSON({
              payload: {
                $case: "message",
                value: agentMessage("no ack", { contextId: "reply" })
              }
            })
          });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id ?? 1,
          result: SendMessageResponse.toJSON({
            payload: {
              $case: "task",
              value: makeTask({
                id: "task-remote-1",
                contextId: "reply",
                state: TaskState.TASK_STATE_SUBMITTED
              })
            }
          })
        });
      }
      return Response.json(AgentCard.toJSON(card));
    })
  );
}

/** A signed Slack Interactivity POST (form-encoded `payload=`). */
async function interactivityRequest(payload: unknown): Promise<Request> {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const headers = await slackHeaders(body);
  return new Request(`${ISSUER}/slack/interactivity`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
}

/** A freeform-modal submission, as Slack posts it after the typed answer. */
function freeformSubmission(requestId: string, text: string) {
  return {
    type: "view_submission",
    user: { id: "U1" },
    view: {
      callback_id: SLACK_FREEFORM_CALLBACK_ID,
      private_metadata: requestId,
      state: {
        values: {
          [SLACK_FREEFORM_BLOCK_ID]: {
            [SLACK_FREEFORM_ACTION_ID]: {
              type: "plain_text_input",
              value: text
            }
          }
        }
      }
    }
  };
}

function buttonAction(requestId: string, optionId: string) {
  return {
    type: "block_actions",
    user: { id: "U1" },
    trigger_id: "trig-1",
    channel: { id: "C1" },
    message: { ts: "1700.9" },
    actions: [
      {
        action_id: `input:${requestId}:button:0`,
        value: optionId,
        type: "button"
      }
    ]
  };
}

async function seedParkedRequest(requestId: string) {
  await createAgentTask({
    token: "tok-1",
    taskId: "task-1",
    agentName: "remoteagent",
    channelId: "C1",
    messageTs: "1700.1",
    replyThreadTs: "1700.1",
    eventId: "Ev1"
  });
  await suspendForInput("tok-1");
  await createHitlRequest({
    requestId,
    token: "tok-1",
    taskId: "task-1",
    contextId: "reply",
    agentName: "remoteagent",
    channelId: "C1",
    threadTs: "1700.1",
    requestKind: "approval",
    promptText: "Proceed?",
    optionsJson: JSON.stringify([
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" }
    ]),
    allowFreeform: false,
    deadlineAt: Math.floor(Date.now() / 1000) + 600
  });
  // Simulate the prompt having been posted, so the answered-state update targets it.
  await setHitlSlackMessageTs(requestId, "1700.9");
}

beforeEach(async () => {
  _resetIssuerCacheForTest();
  await setPublicUrl(ISSUER);
  await setAllowedRemoteAgentDomains(["remote.example.com"]);
  await registerAgent({
    name: "remoteagent",
    kind: "remote",
    a2aEndpoint: ENDPOINT,
    tenantId: "main",
    notifyOn: "mention",
    workspaceId: 0
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleSlackInteractivity", () => {
  it("rejects a request with a bad signature", async () => {
    const req = new Request(`${ISSUER}/slack/interactivity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": "1",
        "x-slack-signature": "v0=deadbeef"
      },
      body: "payload=%7B%7D"
    });
    const ctx = createExecutionContext();
    const res = await handleSlackInteractivity(req, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("claims a button answer, updates Slack, and resumes the task", async () => {
    await seedParkedRequest("req-1");
    const captured: Captured = {
      slackUpdates: [],
      slackEphemerals: [],
      slackReplies: [],
      resumeMessages: []
    };
    stub(captured);

    const ctx = createExecutionContext();
    const res = await handleSlackInteractivity(
      await interactivityRequest(buttonAction("req-1", "approve")),
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);

    // Request is now answered by U1.
    const row = await getHitlRequest("req-1");
    expect(row?.status).toBe("answered");
    expect(row?.answeredBy).toBe("U1");
    expect(row?.answeredOptionId).toBe("approve");

    // Slack prompt updated to the answered state.
    expect(captured.slackUpdates).toHaveLength(1);

    // Task resumed: an A2A continuation went to the remote carrying the answer.
    expect(captured.resumeMessages).toHaveLength(1);
    const resume = captured.resumeMessages[0];
    expect(resume.taskId).toBe("task-1");
    expect(resume.referenceTaskIds).toEqual(["task-1"]);
    const answer = resume.parts.map(dataOf).find((d) => d !== undefined);
    expect(answer).toMatchObject({
      type: HITL_RESPONSE_TYPE,
      requestId: "req-1",
      optionId: "approve"
    });
    // The human-readable option label rides in the text part.
    expect(partsText(resume.parts)).toBe("Approve");

    // The paired task row is un-parked.
    expect((await getAgentTaskByToken("tok-1"))?.status).toBe("pending");
  });

  it("posts an ephemeral and does not resume when already answered", async () => {
    await seedParkedRequest("req-2");
    const captured: Captured = {
      slackUpdates: [],
      slackEphemerals: [],
      slackReplies: [],
      resumeMessages: []
    };
    stub(captured);

    // First answer wins.
    const ctx1 = createExecutionContext();
    await handleSlackInteractivity(
      await interactivityRequest(buttonAction("req-2", "approve")),
      ctx1
    );
    await waitOnExecutionContext(ctx1);

    // Second click on the same (now answered) prompt.
    const ctx2 = createExecutionContext();
    await handleSlackInteractivity(
      await interactivityRequest(buttonAction("req-2", "reject")),
      ctx2
    );
    await waitOnExecutionContext(ctx2);

    expect(captured.resumeMessages).toHaveLength(1); // only the first resumed
    expect(captured.slackEphemerals).toHaveLength(1); // second got a notice
    expect(captured.slackEphemerals[0].get("user")).toBe("U1");
  });

  it("notifies the thread when the remote does not accept the resumed answer", async () => {
    await seedParkedRequest("req-3");
    const captured: Captured = {
      slackUpdates: [],
      slackEphemerals: [],
      slackReplies: [],
      resumeMessages: []
    };
    stub(captured, { rejectResume: true });

    const ctx = createExecutionContext();
    await handleSlackInteractivity(
      await interactivityRequest(buttonAction("req-3", "approve")),
      ctx
    );
    await waitOnExecutionContext(ctx);

    // The answer is recorded and the prompt still shows the answered state — the
    // human's action stands; only the handoff to the agent failed.
    const row = await getHitlRequest("req-3");
    expect(row?.status).toBe("answered");
    expect(captured.slackUpdates).toHaveLength(1);

    // The continuation was attempted but not accepted, so the task stays parked.
    expect(captured.resumeMessages).toHaveLength(1);
    expect((await getAgentTaskByToken("tok-1"))?.status).toBe("awaiting-input");

    // The thread is told the agent couldn't be reached, so the user can fix it.
    expect(captured.slackReplies).toHaveLength(1);
    expect(captured.slackReplies[0].get("thread_ts")).toBe("1700.1");
    expect(captured.slackReplies[0].get("text")).toContain("remoteagent");
  });
});

/**
 * The size bound on a typed answer, enforced where it can still be corrected.
 *
 * The agent runtime refuses message text over `MAX_MESSAGE_TEXT_BYTES`. If the
 * gatekeeper finds that out during the resume — which runs in `ctx.waitUntil`,
 * after the response has gone — the prompt has already been claimed, so the
 * answer is lost and the question can never be answered again. These three cases
 * pin the boundary that keeps it correctable instead: one byte over, exactly at
 * the limit, and the same limit measured in bytes rather than characters.
 */
describe("an over-long freeform answer", () => {
  const emptyCapture = (): Captured => ({
    slackUpdates: [],
    slackEphemerals: [],
    slackReplies: [],
    resumeMessages: []
  });

  it("is refused with the modal left open, and leaves the prompt answerable", async () => {
    await seedParkedRequest("req-long");
    const captured = emptyCapture();
    stub(captured);

    const ctx = createExecutionContext();
    const res = await handleSlackInteractivity(
      await interactivityRequest(
        freeformSubmission("req-long", "a".repeat(MAX_MESSAGE_TEXT_BYTES + 1))
      ),
      ctx
    );
    await waitOnExecutionContext(ctx);

    // `response_action: "errors"` is what keeps the modal open with the typed
    // text still in it; the block id is what puts the message under the input.
    expect(await res.json()).toEqual({
      response_action: "errors",
      errors: {
        [SLACK_FREEFORM_BLOCK_ID]: expect.stringContaining("too long")
      }
    });

    // Nothing was consumed: no resume, no answered-state update, and — the one
    // that matters — the prompt is still open for a shorter answer.
    expect(captured.resumeMessages).toEqual([]);
    expect(captured.slackUpdates).toEqual([]);
    expect((await getHitlRequest("req-long"))?.status).toBe("awaiting");
    expect((await getAgentTaskByToken("tok-1"))?.status).toBe("awaiting-input");
  });

  it("goes through at exactly the limit", async () => {
    // The off-by-one that would make the check useful-looking and wrong.
    await seedParkedRequest("req-exact");
    const captured = emptyCapture();
    stub(captured);

    const answer = "a".repeat(MAX_MESSAGE_TEXT_BYTES);
    const ctx = createExecutionContext();
    const res = await handleSlackInteractivity(
      await interactivityRequest(freeformSubmission("req-exact", answer)),
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(captured.resumeMessages).toHaveLength(1);
    expect(partsText(captured.resumeMessages[0].parts)).toBe(answer);
    expect((await getHitlRequest("req-exact"))?.status).toBe("answered");
  });

  it("measures bytes, not characters", async () => {
    // The distinction the contract is explicit about. This answer is well under
    // the limit in characters and one byte over it in UTF-8, so a length check
    // would let it through to be refused by the agent, too late to fix.
    await seedParkedRequest("req-utf8");
    const captured = emptyCapture();
    stub(captured);

    const multibyte = "é".repeat(MAX_MESSAGE_TEXT_BYTES / 2) + "a";
    expect(multibyte.length).toBeLessThan(MAX_MESSAGE_TEXT_BYTES);

    const ctx = createExecutionContext();
    const res = await handleSlackInteractivity(
      await interactivityRequest(freeformSubmission("req-utf8", multibyte)),
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { response_action?: string }).response_action
    ).toBe("errors");
    expect((await getHitlRequest("req-utf8"))?.status).toBe("awaiting");
  });
});
