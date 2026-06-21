/**
 * Canonical JSON for AgentCard signing.
 *
 * This MUST byte-for-byte match the gateway's verifier
 * (`src/a2a/card-verify.ts` → `canonicalCardPayload` + `base64UrlOfString`).
 * Contract:
 *  - object keys sorted recursively (ascending, `Object.keys().sort()`),
 *  - `JSON.stringify` with no insignificant whitespace,
 *  - the `signatures` field excluded from the signed payload,
 *  - payload bytes = UTF-8, then base64url (no padding) for the JWS.
 *
 * Any deviation makes a signature that the gateway computes over a different
 * byte string, so verification fails. Keep these two files in lockstep.
 */

/** Recursively sort object keys so serialization is deterministic. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeys(src[k]);
    return out;
  }
  return value;
}

/** Canonical JSON of the card with `signatures` removed (the signed payload). */
export function canonicalCardPayload(card: Record<string, unknown>): string {
  const { signatures: _signatures, ...rest } = card;
  void _signatures;
  return JSON.stringify(sortKeys(rest));
}

/** base64url(no padding) of a UTF-8 string. */
export function base64UrlOfString(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
