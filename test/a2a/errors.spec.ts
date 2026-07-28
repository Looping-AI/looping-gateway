import { describe, it, expect } from "vitest";
import { A2A_ERROR_CODE } from "@a2a-js/sdk/errors";
import { classifyA2AError, isPermanentProtocolError } from "@/a2a/errors";

/**
 * The classifier duck-types `envelopeCode` rather than using `instanceof`,
 * because `@a2a-js/sdk/client` and `@a2a-js/sdk/errors` are separately bundled
 * and each carries its own copy of the error hierarchy. These tests therefore
 * construct error-shaped objects directly — that is exactly the contract.
 */
function protocolError(code: number, reason?: string): Error {
  const err = Object.assign(new Error("refused"), { envelopeCode: code });
  return reason ? Object.assign(err, { reason }) : err;
}

describe("classifyA2AError", () => {
  it("classifies a JSON-RPC error envelope as protocol, keeping the code", () => {
    const out = classifyA2AError(
      protocolError(
        A2A_ERROR_CODE.VERSION_NOT_SUPPORTED,
        "VERSION_NOT_SUPPORTED"
      )
    );
    expect(out).toEqual({
      kind: "protocol",
      code: -32009,
      reason: "VERSION_NOT_SUPPORTED",
      message: "refused"
    });
  });

  it("falls back to UNKNOWN when the SDK left no usable reason", () => {
    // `JsonRpcTransportError` (every code without a semantic twin) is exactly
    // this shape — which is why `reason` must never be branched on.
    const out = classifyA2AError(
      protocolError(A2A_ERROR_CODE.METHOD_NOT_FOUND)
    );
    expect(out).toMatchObject({
      kind: "protocol",
      code: -32601,
      reason: "UNKNOWN"
    });
  });

  it("classifies a plain Error as transport", () => {
    expect(classifyA2AError(new Error("ECONNREFUSED"))).toEqual({
      kind: "transport",
      message: "ECONNREFUSED"
    });
  });

  it("treats a non-numeric envelopeCode as transport, not protocol", () => {
    // A string code would otherwise sail through a truthiness check and be
    // switched on as if it were a real A2A verdict.
    const out = classifyA2AError(
      Object.assign(new Error("weird"), { envelopeCode: "-32009" })
    );
    expect(out).toEqual({ kind: "transport", message: "weird" });
  });

  it("survives non-Error throwables", () => {
    expect(classifyA2AError(null)).toEqual({
      kind: "transport",
      message: "null"
    });
    expect(classifyA2AError("boom")).toEqual({
      kind: "transport",
      message: "boom"
    });
  });
});

describe("isPermanentProtocolError", () => {
  it("treats INTERNAL_ERROR as retryable — it is a fault, not a verdict", () => {
    expect(isPermanentProtocolError(A2A_ERROR_CODE.INTERNAL_ERROR)).toBe(false);
  });

  it("treats every request-verdict code as permanent", () => {
    for (const code of [
      A2A_ERROR_CODE.VERSION_NOT_SUPPORTED,
      A2A_ERROR_CODE.INVALID_PARAMS,
      A2A_ERROR_CODE.UNSUPPORTED_OPERATION,
      A2A_ERROR_CODE.PUSH_NOTIFICATION_NOT_SUPPORTED,
      A2A_ERROR_CODE.CONTENT_TYPE_NOT_SUPPORTED,
      A2A_ERROR_CODE.EXTENSION_SUPPORT_REQUIRED,
      A2A_ERROR_CODE.METHOD_NOT_FOUND,
      A2A_ERROR_CODE.PARSE_ERROR,
      A2A_ERROR_CODE.INVALID_REQUEST
    ]) {
      expect(isPermanentProtocolError(code)).toBe(true);
    }
  });
});
