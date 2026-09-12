import { describe, it, expect } from "vitest";
import { Role, type Message } from "@a2a-js/sdk";
import { buildMessage, textPart } from "@/a2a/parts";
import {
  buildHitlResponseParts,
  buildHitlTimeoutParts,
  HITL_APPROVE_OPTION_ID,
  HITL_REJECT_OPTION_ID,
  HITL_REQUEST_TYPE
} from "@/a2a/hitl";
import {
  answeredCall,
  approvedCall,
  hitlRequestOf,
  NOT_ASKED_NOTE,
  openCallOf,
  humanAnswerOf,
  refusalReason,
  refusedCall,
  settledCall,
  wasApproved,
  withRefusal,
  type OpenCall
} from "@/agents/shared/open-call";

const question = {
  question: "Which environment?",
  options: [
    { label: "dev" },
    { label: "prod", description: "Customers see it" }
  ]
};

const call = (
  toolName: string,
  toolCallId: string,
  input: unknown = question
) => ({
  toolName,
  toolCallId,
  input
});

/** An approval as the SDK puts it among a step's content parts. */
const approvalPart = (
  approvalId: string,
  toolCallId: string,
  extra: { reason?: string; isAutomatic?: boolean } = {}
) => ({
  type: "tool-approval-request",
  approvalId,
  toolCall: call("agents_delete", toolCallId, { name: "arc-player" }),
  ...extra
});

/** A step that raised nothing but the calls given. */
const step = (
  staticToolCalls: ReturnType<typeof call>[] = [],
  content: { type: string }[] = []
) => ({ staticToolCalls, content });

const held: OpenCall = {
  requestId: "req-1",
  toolCallId: "tc-ask",
  toolName: "ask_user",
  input: question,
  createdAt: 0
};

const gated: OpenCall = {
  requestId: "aitxt-1",
  toolCallId: "tc-del",
  toolName: "agents_delete",
  input: { name: "arc-player" },
  approval: { reason: "Delete agent *arc-player*?" },
  createdAt: 0
};

function message(parts: Message["parts"]): Message {
  return buildMessage({
    messageId: "m1",
    role: Role.ROLE_USER,
    parts,
    contextId: "c1",
    taskId: "t1"
  });
}

describe("openCallOf", () => {
  it("is undefined for a step that asked nothing", () => {
    expect(openCallOf(step([call("work", "tc1", {})]))).toBeUndefined();
  });

  it("pauses on the first question and records the rest as not asked", () => {
    const pause = openCallOf(
      step([
        call("work", "tc1", {}),
        call("ask_user", "tc-a"),
        call("ask_user", "tc-b")
      ]),
      42
    );

    expect(pause?.call).toMatchObject({
      toolCallId: "tc-a",
      toolName: "ask_user",
      input: question,
      createdAt: 42
    });
    expect(pause?.notRaised).toEqual([
      {
        toolCallId: "tc-b",
        toolName: "ask_user",
        input: question,
        errorText: NOT_ASKED_NOTE
      }
    ]);
  });

  it("mints the request id instead of borrowing the provider's call id", () => {
    // The shape Workers AI hands back: its own id, a marker, and a random suffix.
    // The request id ends up inside a Slack action id, which Slack caps.
    const providerId = `chatcmpl-tool-${"f".repeat(32)}::cf-wai-tool-call::a1b2c3d4e5f6g7h8`;
    const pause = openCallOf(step([call("ask_user", providerId)]));

    expect(pause?.call.toolCallId).toBe(providerId);
    expect(pause?.call.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("pauses on an approval, under the SDK's own approval id", () => {
    // Not a minted one: the id is what the replay has to quote back for the SDK
    // to recognize the decision, and it is already short enough for Slack.
    const pause = openCallOf(
      step([], [approvalPart("aitxt-abc", "tc-del")]),
      7
    );

    expect(pause?.call).toEqual({
      requestId: "aitxt-abc",
      toolCallId: "tc-del",
      toolName: "agents_delete",
      input: { name: "arc-player" },
      approval: {},
      createdAt: 7
    });
  });

  it("keeps the policy's reason, which is what the human is shown", () => {
    const pause = openCallOf(
      step([], [approvalPart("aitxt-abc", "tc-del", { reason: "Delete it?" })])
    );
    expect(pause?.call.approval).toEqual({ reason: "Delete it?" });
  });

  it("ignores an approval the policy decided on its own", () => {
    // `isAutomatic` marks an approved/denied the policy settled without a human.
    // Pausing on one would park a task nobody was ever going to be asked about.
    expect(
      openCallOf(
        step([], [approvalPart("aitxt-abc", "tc-del", { isAutomatic: true })])
      )
    ).toBeUndefined();
  });

  it("lets a question out-rank an approval raised in the same step", () => {
    // Asking means the model is unsure what was wanted, and an approval decided
    // against an unclear request is the one decision a human should not be handed.
    const pause = openCallOf(
      step([call("ask_user", "tc-a")], [approvalPart("aitxt-abc", "tc-del")])
    );

    expect(pause?.call.toolName).toBe("ask_user");
    expect(pause?.notRaised).toEqual([
      {
        toolCallId: "tc-del",
        toolName: "agents_delete",
        input: { name: "arc-player" },
        errorText: NOT_ASKED_NOTE
      }
    ]);
  });

  it("records a second approval in the same step as not asked", () => {
    const pause = openCallOf(
      step(
        [],
        [approvalPart("aitxt-1", "tc-a"), approvalPart("aitxt-2", "tc-b")]
      )
    );

    expect(pause?.call.requestId).toBe("aitxt-1");
    expect(pause?.notRaised).toEqual([
      expect.objectContaining({ toolCallId: "tc-b", errorText: NOT_ASKED_NOTE })
    ]);
  });
});

describe("hitlRequestOf", () => {
  it("renders a question as a choice, with a typed answer allowed by default", () => {
    expect(hitlRequestOf(held)).toEqual({
      type: HITL_REQUEST_TYPE,
      requestId: "req-1",
      requestKind: "choice",
      prompt: "Which environment?",
      options: [
        { id: "opt_0", label: "dev" },
        { id: "opt_1", label: "prod", description: "Customers see it" }
      ],
      display: "buttons",
      allowFreeform: true
    });
  });

  it("refuses a kept input that is no longer a question", () => {
    expect(() => hitlRequestOf({ ...held, input: { question: "" } })).toThrow();
  });

  it("renders an approval as Approve/Reject, prompting with the policy's reason", () => {
    // No options: the gatekeeper fills in the canonical pair for an `approval`.
    expect(hitlRequestOf(gated)).toEqual({
      type: HITL_REQUEST_TYPE,
      requestId: "aitxt-1",
      requestKind: "approval",
      prompt: "Delete agent *arc-player*?"
    });
  });

  it("names the tool when the policy gave no reason to show", () => {
    expect(hitlRequestOf({ ...gated, approval: {} }).prompt).toBe(
      "Approve `agents_delete`?"
    );
  });
});

describe("humanAnswerOf", () => {
  const button = buildHitlResponseParts({
    requestId: "req-1",
    optionId: "opt_1",
    answeredBy: "U9",
    humanText: "prod"
  });

  it("reads a button answer: the label, who gave it, and which button", () => {
    expect(humanAnswerOf(message(button), "Grace")).toEqual({
      requestId: "req-1",
      answer: {
        kind: "answered",
        text: "prod",
        by: "Grace",
        optionId: "opt_1"
      }
    });
  });

  it("names the answerer by Slack id when no display name is known", () => {
    expect(humanAnswerOf(message(button), null)?.answer).toMatchObject({
      by: "U9"
    });
  });

  it("reads a timeout", () => {
    expect(
      humanAnswerOf(message(buildHitlTimeoutParts("req-1")), "Grace")
    ).toEqual({ requestId: "req-1", answer: { kind: "timed-out" } });
  });

  it("is null for an ordinary message", () => {
    expect(humanAnswerOf(message([textPart("hello")]), "Grace")).toBeNull();
  });
});

describe("wasApproved", () => {
  const answer = (optionId?: string) =>
    ({
      kind: "answered",
      text: "x",
      by: "Grace",
      ...(optionId ? { optionId } : {})
    }) as const;

  it("is true only for the Approve button", () => {
    expect(wasApproved(answer(HITL_APPROVE_OPTION_ID))).toBe(true);
  });

  it("is false for Reject", () => {
    expect(wasApproved(answer(HITL_REJECT_OPTION_ID))).toBe(false);
  });

  it("is false for a typed answer that chose no button", () => {
    // Freeform text is not consent to a destructive action.
    expect(wasApproved(answer())).toBe(false);
  });

  it("is false for a timeout", () => {
    expect(wasApproved({ kind: "timed-out" })).toBe(false);
  });
});

describe("answeredCall", () => {
  it("carries the answer as the call's result", () => {
    expect(
      answeredCall(held, { kind: "answered", text: "prod", by: "Grace" })
    ).toEqual({
      toolCallId: "tc-ask",
      toolName: "ask_user",
      input: question,
      output: { answer: "prod", answeredBy: "Grace" }
    });
  });

  it("records a timeout as a result, not a failed call", () => {
    // A failed call reads as "fix it and try again" — the wrong lesson for a
    // question nobody got round to answering.
    const record = answeredCall(held, { kind: "timed-out" });
    expect(record.errorText).toBeUndefined();
    expect(record.output).toMatchObject({ answered: false });
  });
});

describe("approvedCall", () => {
  it("replays the model's own call, carrying the decision and no result", () => {
    // The absence of a result is what makes the SDK run it: this is a decision
    // handed back, not an outcome being reported.
    expect(approvedCall(gated, "Grace")).toEqual({
      toolCallId: "tc-del",
      toolName: "agents_delete",
      input: { name: "arc-player" },
      approval: {
        id: "aitxt-1",
        approved: true,
        reason: "Approved in Slack by Grace."
      }
    });
  });

  it("replays the input exactly, so what runs is what was approved", () => {
    const call = { ...gated, input: { name: "arc-player", extra: [1, 2] } };
    expect(approvedCall(call, "Grace").input).toEqual({
      name: "arc-player",
      extra: [1, 2]
    });
  });
});

describe("refusedCall", () => {
  it("records a refusal against the approval, with no result", () => {
    const record = refusedCall(gated, "Rejected in Slack by Grace.");
    expect(record).toEqual({
      toolCallId: "tc-del",
      toolName: "agents_delete",
      input: { name: "arc-player" },
      approval: {
        id: "aitxt-1",
        approved: false,
        reason: "Rejected in Slack by Grace."
      }
    });
    expect(record.output).toBeUndefined();
  });
});

describe("refusalReason", () => {
  it("names whoever said no", () => {
    expect(
      refusalReason({ kind: "answered", text: "Reject", by: "Grace" })
    ).toBe("Rejected in Slack by Grace.");
  });

  it("says a timeout expired rather than blaming anyone", () => {
    expect(refusalReason({ kind: "timed-out" })).toBe(
      "The approval request expired with no response."
    );
  });
});

describe("withRefusal", () => {
  it("turns an approved call that never ran into a refusal", () => {
    const record = withRefusal(
      approvedCall(gated, "Grace"),
      "Not carried out."
    );
    expect(record.approval).toEqual({
      id: "aitxt-1",
      approved: false,
      reason: "Not carried out."
    });
  });

  it("never invents an approval id for a call that had none", () => {
    // An id made up here would claim a decision nobody made.
    const record = withRefusal(
      { toolCallId: "tc1", toolName: "work", input: {} },
      "Not carried out."
    );
    expect(record.approval).toBeUndefined();
    expect(record.errorText).toBe("Not carried out.");
  });
});

describe("settledCall", () => {
  it("keeps the decision and adds what the call produced", () => {
    const record = settledCall(approvedCall(gated, "Grace"), {
      output: { ok: true, deleted: "arc-player" }
    });
    expect(record.output).toEqual({ ok: true, deleted: "arc-player" });
    expect(record.approval).toMatchObject({ id: "aitxt-1", approved: true });
  });

  it("keeps the decision when the approved call failed", () => {
    const record = settledCall(approvedCall(gated, "Grace"), {
      errorText: "boom"
    });
    expect(record.errorText).toBe("boom");
    expect(record.approval).toMatchObject({ approved: true });
  });
});
