import { describe, it, expect } from "vitest";
import type { Message } from "@a2a-js/sdk";
import {
  parseHitlRequest,
  parseHitlResponse,
  parseHitlTimeout,
  type HitlRequest,
  toSlackInputRequest,
  buildHitlRequestParts,
  buildHitlResponseParts,
  buildHitlTimeoutParts,
  optionLabel,
  approvalOptions,
  HITL_REQUEST_TYPE,
  HITL_RESPONSE_TYPE,
  HITL_TIMEOUT_TYPE,
  HITL_APPROVE_OPTION_ID,
  HITL_REJECT_OPTION_ID
} from "@/a2a/hitl";

function msg(parts: Message["parts"]): Message {
  return { kind: "message", messageId: "m1", role: "agent", parts };
}

describe("parseHitlRequest", () => {
  it("extracts a valid request DataPart", () => {
    const req = parseHitlRequest(
      msg([
        { kind: "text", text: "Proceed?" },
        {
          kind: "data",
          data: {
            type: HITL_REQUEST_TYPE,
            requestId: "req-1",
            requestKind: "approval",
            prompt: "Proceed?"
          }
        }
      ])
    );
    expect(req).not.toBeNull();
    expect(req?.requestId).toBe("req-1");
    expect(req?.requestKind).toBe("approval");
  });

  it("returns null when no HITL DataPart is present", () => {
    expect(parseHitlRequest(msg([{ kind: "text", text: "hi" }]))).toBeNull();
  });

  it("returns null for a DataPart of a different type", () => {
    expect(
      parseHitlRequest(
        msg([{ kind: "data", data: { type: "something.else", x: 1 } }])
      )
    ).toBeNull();
  });

  it("returns null for a malformed request (missing requestId)", () => {
    expect(
      parseHitlRequest(
        msg([
          {
            kind: "data",
            data: {
              type: HITL_REQUEST_TYPE,
              requestKind: "choice",
              prompt: "?"
            }
          }
        ])
      )
    ).toBeNull();
  });

  it("returns null for an undefined message", () => {
    expect(parseHitlRequest(undefined)).toBeNull();
  });

  it("prefers the first valid DataPart and ignores non-HITL data", () => {
    const req = parseHitlRequest(
      msg([
        { kind: "data", data: { type: "noise" } },
        {
          kind: "data",
          data: {
            type: HITL_REQUEST_TYPE,
            requestId: "req-x",
            requestKind: "choice",
            prompt: "Pick",
            options: [{ id: "a", label: "A" }]
          }
        }
      ])
    );
    expect(req?.requestId).toBe("req-x");
  });
});

describe("toSlackInputRequest", () => {
  it("fills canonical Approve/Reject options for an approval with no options", () => {
    const slack = toSlackInputRequest({
      type: HITL_REQUEST_TYPE,
      requestId: "r",
      requestKind: "approval",
      prompt: "OK to deploy?"
    });
    expect(slack.options).toEqual(approvalOptions());
    expect(slack.options?.map((o) => o.id)).toEqual([
      HITL_APPROVE_OPTION_ID,
      HITL_REJECT_OPTION_ID
    ]);
    // Reject carries the danger accent.
    expect(
      slack.options?.find((o) => o.id === HITL_REJECT_OPTION_ID)?.style
    ).toBe("danger");
    expect(slack.display).toBe("buttons"); // default
  });

  it("passes through explicit options and display", () => {
    const slack = toSlackInputRequest({
      type: HITL_REQUEST_TYPE,
      requestId: "r",
      requestKind: "choice",
      prompt: "Which env?",
      display: "select",
      allowFreeform: true,
      options: [
        { id: "stg", label: "Staging" },
        { id: "prod", label: "Production", style: "danger" }
      ]
    });
    expect(slack.display).toBe("select");
    expect(slack.allowFreeform).toBe(true);
    expect(slack.options?.map((o) => o.id)).toEqual(["stg", "prod"]);
  });

  it("leaves options undefined for a choice with none (freeform-only prompt)", () => {
    const slack = toSlackInputRequest({
      type: HITL_REQUEST_TYPE,
      requestId: "r",
      requestKind: "choice",
      prompt: "Tell me"
    });
    expect(slack.options).toBeUndefined();
  });
});

describe("optionLabel", () => {
  const opts = [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" }
  ];
  it("resolves a label by id", () => {
    expect(optionLabel(opts, "b")).toBe("Beta");
  });
  it("returns undefined for an unknown or missing id", () => {
    expect(optionLabel(opts, "z")).toBeUndefined();
    expect(optionLabel(opts, undefined)).toBeUndefined();
  });
});

describe("buildHitlResponseParts", () => {
  it("builds a human TextPart plus a structured response DataPart", () => {
    const parts = buildHitlResponseParts({
      requestId: "req-1",
      optionId: "approve",
      answeredBy: "U1",
      humanText: "Approve"
    });
    expect(parts[0]).toEqual({ kind: "text", text: "Approve" });
    expect(parts[1]).toMatchObject({
      kind: "data",
      data: {
        type: HITL_RESPONSE_TYPE,
        requestId: "req-1",
        optionId: "approve",
        answeredBy: "U1"
      }
    });
  });

  it("includes freeform text and omits optionId when absent", () => {
    const parts = buildHitlResponseParts({
      requestId: "req-2",
      text: "do the other thing",
      answeredBy: "U2",
      humanText: "do the other thing"
    });
    const data = (parts[1] as { data: Record<string, unknown> }).data;
    expect(data.text).toBe("do the other thing");
    expect(data.optionId).toBeUndefined();
  });
});

describe("buildHitlTimeoutParts", () => {
  it("carries the timeout DataPart and a human fallback", () => {
    const parts = buildHitlTimeoutParts("req-9");
    expect(parts[0].kind).toBe("text");
    expect(parts[1]).toEqual({
      kind: "data",
      data: { type: HITL_TIMEOUT_TYPE, requestId: "req-9" }
    });
  });
});

describe("buildHitlRequestParts", () => {
  it("carries a TextPart fallback plus the request DataPart, and round-trips", () => {
    const req = {
      type: HITL_REQUEST_TYPE,
      requestId: "req-42",
      requestKind: "choice",
      prompt: "Pick one",
      options: [{ id: "opt_0", label: "A" }],
      allowFreeform: true
    } satisfies HitlRequest;
    const parts = buildHitlRequestParts(req);
    expect(parts[0]).toEqual({ kind: "text", text: "Pick one" });

    // The DataPart is exactly what parseHitlRequest reads back.
    const parsed = parseHitlRequest(msg(parts));
    expect(parsed).toMatchObject({
      requestId: "req-42",
      requestKind: "choice",
      prompt: "Pick one",
      allowFreeform: true
    });
  });
});

describe("parseHitlResponse", () => {
  it("extracts a valid response DataPart (option answer)", () => {
    const parts = buildHitlResponseParts({
      requestId: "req-1",
      optionId: HITL_APPROVE_OPTION_ID,
      answeredBy: "U9",
      humanText: "Approve"
    });
    const res = parseHitlResponse(msg(parts));
    expect(res).toMatchObject({
      requestId: "req-1",
      optionId: HITL_APPROVE_OPTION_ID,
      answeredBy: "U9"
    });
  });

  it("extracts a freeform answer and returns null when absent", () => {
    const parts = buildHitlResponseParts({
      requestId: "req-2",
      text: "something else",
      answeredBy: "U9",
      humanText: "something else"
    });
    expect(parseHitlResponse(msg(parts))?.text).toBe("something else");
    expect(parseHitlResponse(msg([{ kind: "text", text: "hi" }]))).toBeNull();
  });

  it("returns null for a malformed response with neither optionId nor text", () => {
    expect(
      parseHitlResponse(
        msg([
          {
            kind: "data",
            data: {
              type: HITL_RESPONSE_TYPE,
              requestId: "req-3",
              answeredBy: "U9"
            }
          }
        ])
      )
    ).toBeNull();
  });
});

describe("parseHitlTimeout", () => {
  it("extracts the requestId and returns null when absent", () => {
    const parts = buildHitlTimeoutParts("req-7");
    expect(parseHitlTimeout(msg(parts))).toEqual({ requestId: "req-7" });
    expect(parseHitlTimeout(msg([{ kind: "text", text: "hi" }]))).toBeNull();
  });
});
