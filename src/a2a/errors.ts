import { A2A_ERROR_CODE } from "@a2a-js/sdk/errors";

/**
 * How an error thrown by the A2A SDK client reached us.
 *
 * The distinction is the one A2A v1.0 draws by lifecycle phase, and it is the
 * only reliable retry signal on any outbound call:
 * - `protocol` — the agent parsed the request and answered with a JSON-RPC error
 *   envelope, i.e. a *verdict about the request*. Re-sending the identical
 *   request gets the identical code back.
 * - `transport` — nothing spoke A2A: DNS, TLS, a timeout/abort, a 5xx with a
 *   non-JSON-RPC body. Retrying is exactly the right response.
 *
 * Note the asymmetry the SDK gives us for free: a JSON-RPC error envelope is
 * deserialized into an `A2AError` subclass carrying `envelopeCode`, while a raw
 * HTTP/network failure surfaces as a plain `Error` with no such field. That is
 * the whole basis of {@link classifyA2AError}.
 */
export type A2AErrorClassification =
  | { kind: "protocol"; code: number; reason: string; message: string }
  | { kind: "transport"; message: string };

/**
 * Classify an error thrown by the A2A SDK client.
 *
 * Deliberately reads the wire code instead of testing `instanceof` against the
 * semantic error classes (`TaskNotFoundError` & co.): `@a2a-js/sdk/client` and
 * `@a2a-js/sdk/errors` are separately bundled entry points that each carry
 * their own copy of the error hierarchy, so the class the client throws is a
 * *different class object* from the one importable here and `instanceof` is
 * always false — every typed outcome would silently degrade to a generic
 * error. The codes are spec-defined (A2A §5.4) and identical across both
 * copies, so they are the stable thing to classify on.
 *
 * `reason` is best-effort and for logs only — never branch on it. The SDK
 * returns a bare `JsonRpcTransportError` for every code without a semantic twin
 * (`PARSE_ERROR`, `INVALID_REQUEST`, `METHOD_NOT_FOUND`, any vendor code), and
 * that class leaves `reason` at its `"INTERNAL_ERROR"` default regardless of
 * the actual code. Only `code` is trustworthy.
 */
export function classifyA2AError(err: unknown): A2AErrorClassification {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { envelopeCode?: unknown } | null)?.envelopeCode;
  if (typeof code !== "number") return { kind: "transport", message };
  const reason = (err as { reason?: unknown }).reason;
  return {
    kind: "protocol",
    code,
    reason: typeof reason === "string" ? reason : "UNKNOWN",
    message
  };
}

/**
 * Whether a protocol error is a *deterministic* refusal — the agent understood
 * the request and rejected it, so re-sending it unchanged is pointless and the
 * user should be told what is actually wrong instead of watching a retry budget
 * drain into a generic "unreachable" notice.
 *
 * `INTERNAL_ERROR` (-32603) is the sole carve-out: it is the one code that
 * describes a *fault inside the agent* rather than a verdict about the request,
 * so it stays retryable like any transport fault. The trade is deliberate — an
 * agent that persistently returns -32603 still burns the full retry budget and
 * then reports as unreachable. Do not "fix" that by making every code permanent:
 * it would turn a recoverable blip into a hard user-visible failure.
 */
export function isPermanentProtocolError(code: number): boolean {
  return code !== A2A_ERROR_CODE.INTERNAL_ERROR;
}
