import { describe, it, expect } from "vitest";
import { Role, type Message } from "@a2a-js/sdk";
import { buildMessage, textPart } from "@/a2a/parts";
import {
  buildHitlResponseParts,
  buildHitlTimeoutParts,
  HITL_REQUEST_TYPE
} from "@/a2a/hitl";
import {
  answeredCall,
  hitlRequestOf,
  NOT_ASKED_NOTE,
  openCallOf,
  humanAnswerOf,
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

const held: OpenCall = {
  requestId: "req-1",
  toolCallId: "tc-ask",
  toolName: "ask_user",
  input: question,
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
    expect(
      openCallOf({ staticToolCalls: [call("work", "tc1", {})] })
    ).toBeUndefined();
  });

  it("pauses on the first question and records the rest as not asked", () => {
    const pause = openCallOf(
      {
        staticToolCalls: [
          call("work", "tc1", {}),
          call("ask_user", "tc-a"),
          call("ask_user", "tc-b")
        ]
      },
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
    const pause = openCallOf({
      staticToolCalls: [call("ask_user", providerId)]
    });

    expect(pause?.call.toolCallId).toBe(providerId);
    expect(pause?.call.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
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
});

describe("humanAnswerOf", () => {
  const button = buildHitlResponseParts({
    requestId: "req-1",
    optionId: "opt_1",
    answeredBy: "U9",
    humanText: "prod"
  });

  it("reads a button answer: the label, and who gave it", () => {
    expect(humanAnswerOf(message(button), "Grace")).toEqual({
      requestId: "req-1",
      answer: { kind: "answered", text: "prod", by: "Grace" }
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
