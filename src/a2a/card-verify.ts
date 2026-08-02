import {
  AGENT_CARD_PATH,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  AgentCard,
  canonicalizeAgentCard,
  verifyAgentCardSignature as createCardVerifier,
  type AgentCardSignature
} from "@a2a-js/sdk";
import { base64url, type JWK } from "jose";
import { audienceFor, originOf, validateRemoteEndpoint } from "./endpoint";

/**
 * "A knows B is really B" — verify a remote agent's **signed AgentCard**
 * (A2A spec §8.4, RFC 7515) before trusting its endpoint.
 *
 * Combined with TLS + a pinned HTTPS endpoint, a valid card signature proves the
 * card was issued by whoever controls the provider's signing key. The verified
 * key identity (`kid` + `jku`) is pinned in the registry at registration
 * (Trust-On-First-Use), so a later substitution by a different signer is
 * rejected — the same pattern as the Slack `team_id` anchor.
 *
 * Signing contract: A2A v1.0 standardized this, so the canonicalization and JWS
 * verification are the SDK's (`canonicalizeAgentCard` / `verifyAgentCardSignature`)
 * rather than a gateway-local scheme — a detached-payload flattened JWS over the
 * **JCS (RFC 8785)** canonicalization of the card's protobuf-JSON encoding with
 * `signatures` removed, and a protected header carrying `alg`, `kid` and `typ`.
 * What stays gateway-specific is the trust policy layered on top: only `EdDSA`
 * signatures count, the `jku` is fetched through the SSRF allowlist, and the key
 * must be an Ed25519 OKP JWK.
 */

/** Thrown when a card cannot be fetched, is unsigned, or fails verification. */
export class AgentCardVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCardVerificationError";
  }
}

/** The pinned signing identity persisted with a custom agent row. */
export interface CardSigningPin {
  cardSigningJku: string;
  cardSigningKid: string;
}

/** Full result of verifying a remote agent endpoint — pin + card-derived metadata. */
export interface VerifiedAgentCard {
  pin: CardSigningPin;
  /** Display name sourced from `AgentCard.name`. */
  displayName: string;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_CARD_LENGTH = 256 * 1024;
const ALG = "EdDSA";

/**
 * The exact byte string an AgentCard signature is computed over: the card's
 * protobuf-JSON encoding with `signatures` removed, canonicalized per JCS
 * (RFC 8785). Mirrors what {@link createCardVerifier} recomputes internally, so
 * a third-party agent can sign against this and verify here.
 */
export function canonicalCardPayload(card: AgentCard): string {
  const normalized = AgentCard.toJSON(AgentCard.fromJSON(card)) as Record<
    string,
    unknown
  >;
  delete normalized.signatures;
  return canonicalizeAgentCard(normalized as Omit<AgentCard, "signatures">);
}

/** The decoded JWS protected header of a card signature, or null if unreadable. */
function protectedHeaderOf(
  signature: AgentCardSignature
): Record<string, unknown> | null {
  try {
    const decoded = base64url.decode(signature.protected);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decoded));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** GET JSON with an abort timeout and a hard size cap (SSRF/DoS hardening). */
async function fetchJsonCapped(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new AgentCardVerificationError(
        `fetch ${url} returned HTTP ${res.status}`
      );
    }
    const text = await res.text();
    if (text.length > MAX_CARD_LENGTH) {
      throw new AgentCardVerificationError(`response from ${url} too large`);
    }
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof AgentCardVerificationError) throw err;
    throw new AgentCardVerificationError(
      `failed to fetch ${url}: ${(err as Error).message}`
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the public AgentCard from a remote endpoint's well-known path. */
export async function fetchAgentCard(
  endpoint: string,
  allowedDomains: string[] = []
): Promise<AgentCard> {
  validateRemoteEndpoint(endpoint, allowedDomains);
  const path = AGENT_CARD_PATH.startsWith("/")
    ? AGENT_CARD_PATH
    : `/${AGENT_CARD_PATH}`;
  const cardUrl = new URL(path, originOf(endpoint)).toString();
  const raw = await fetchJsonCapped(cardUrl);
  if (!raw || typeof raw !== "object") {
    throw new AgentCardVerificationError(`invalid AgentCard at ${cardUrl}`);
  }
  // Decode through the generated codec rather than casting: the wire form is
  // protobuf-JSON, so this is what normalizes enum names, oneof shapes, and
  // omitted proto defaults into the typed v1.0 card the rest of the code uses.
  let card: AgentCard;
  try {
    card = AgentCard.fromJSON(raw);
  } catch (err) {
    throw new AgentCardVerificationError(
      `invalid AgentCard at ${cardUrl}: ${(err as Error).message}`
    );
  }
  if (typeof card.name !== "string" || card.name.length === 0) {
    throw new AgentCardVerificationError(`invalid AgentCard at ${cardUrl}`);
  }
  return card;
}

/**
 * Resolve the public key referenced by a JWS `jku` + `kid`. Exported so the
 * push-notification callback verifier can reuse the same SSRF-guarded fetch +
 * Ed25519 shape check against a remote's pinned JWKS.
 */
export async function resolveSigningKey(
  jku: string,
  kid: string,
  allowedDomains: string[]
): Promise<JWK> {
  validateRemoteEndpoint(jku, allowedDomains);
  const jwks = (await fetchJsonCapped(jku)) as { keys?: JWK[] };
  const key = jwks.keys?.find((k) => k.kid === kid);
  if (!key) {
    throw new AgentCardVerificationError(
      `signing key '${kid}' not found in JWKS at ${jku}`
    );
  }
  if (key.kty !== "OKP" || key.crv !== "Ed25519") {
    throw new AgentCardVerificationError(
      `signing key '${kid}' is not an Ed25519 (OKP) key`
    );
  }
  return key;
}

/**
 * Verify a remote AgentCard's signature and return the pinned signing identity.
 * Throws {@link AgentCardVerificationError} if the card is unsigned or every
 * signature fails to verify.
 */
export async function verifyAgentCardSignature(
  card: AgentCard,
  opts: { allowedDomains?: string[] } = {}
): Promise<CardSigningPin> {
  const allowedDomains = opts.allowedDomains ?? [];
  const signatures = card.signatures ?? [];
  if (signatures.length === 0) {
    throw new AgentCardVerificationError("AgentCard is not signed");
  }

  // The SDK verifier accepts whatever `alg` the protected header names, so the
  // algorithm restriction is enforced by only ever handing it EdDSA entries.
  const eddsa = signatures.filter((sig) => protectedHeaderOf(sig)?.alg === ALG);
  if (eddsa.length === 0) {
    throw new AgentCardVerificationError(
      `AgentCard has no ${ALG} signature to verify`
    );
  }

  // The verifier returns on the first signature that validates, so the last
  // identity its key lookup resolved is the one that verified — capture it
  // there, since the verifier itself reports only success or failure.
  let pin: CardSigningPin | undefined;
  const verify = createCardVerifier(async (kid, jku) => {
    if (!jku) throw new Error("protected header missing jku");
    const key = await resolveSigningKey(jku, kid, allowedDomains);
    pin = { cardSigningJku: jku, cardSigningKid: kid };
    return key;
  });

  try {
    await verify({ ...card, signatures: eddsa });
  } catch (err) {
    throw new AgentCardVerificationError(
      `AgentCard signature verification failed: ${(err as Error).message}`
    );
  }
  if (!pin) {
    throw new AgentCardVerificationError(
      "AgentCard signature verified without resolving a signing key"
    );
  }
  return pin;
}

/**
 * Fetch one tenant's AgentCard via `GetExtendedAgentCard` (A2A §3.1.11).
 *
 * The well-known path serves a **stub** describing the origin, because that URI
 * is per-authority (RFC 8615) and a host may serve many agents. A tenant's own
 * card — its name, skills and signature — is only reachable here, and the call
 * is authenticated: the agent verifies our gateway JWT before answering, so the
 * token has to name the tenant being asked about.
 */
async function fetchExtendedAgentCard(
  endpoint: string,
  tenantId: string,
  authToken: string
): Promise<AgentCard> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
        [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "GetExtendedAgentCard",
        params: { tenant: tenantId }
      }),
      signal: controller.signal
    });
  } catch (err) {
    throw new AgentCardVerificationError(
      `failed to fetch the extended card for tenant '${tenantId}': ${(err as Error).message}`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new AgentCardVerificationError(
      `extended card request for tenant '${tenantId}' failed: HTTP ${res.status}`
    );
  }
  const text = await res.text();
  if (text.length > MAX_CARD_LENGTH) {
    throw new AgentCardVerificationError(
      `extended card for tenant '${tenantId}' too large`
    );
  }

  let body: { result?: unknown; error?: { message?: string } };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new AgentCardVerificationError(
      `extended card for tenant '${tenantId}' is not valid JSON`
    );
  }
  // JSON-RPC transports errors at HTTP 200, so this is the real failure path —
  // an unknown tenant or a refused token arrives here, not above.
  if (body.error) {
    throw new AgentCardVerificationError(
      `agent refused the extended card request for tenant '${tenantId}': ` +
        `${body.error.message ?? "unknown error"}`
    );
  }
  if (!body.result || typeof body.result !== "object") {
    throw new AgentCardVerificationError(
      `agent returned no card for tenant '${tenantId}'`
    );
  }
  try {
    return AgentCard.fromJSON(body.result);
  } catch (err) {
    throw new AgentCardVerificationError(
      `invalid extended card for tenant '${tenantId}': ${(err as Error).message}`
    );
  }
}

export interface VerifyRemoteAgentArgs {
  endpoint: string;
  /** Which agent at `endpoint` is being registered. */
  tenantId: string;
  allowedDomains?: string[];
  /**
   * Mint the gateway JWT authorizing the extended-card call. Injected rather
   * than imported so these handlers stay offline-testable, the same seam
   * `AdminToolDeps.verifyEndpoint` uses.
   */
  authToken: (audience: string, tenant: string) => Promise<string>;
}

/**
 * One-shot verifier used at agent registration.
 *
 * Two cards, one key:
 *
 *  1. The **stub** at the well-known path establishes who this origin is, and
 *     its signature resolves the `jku`/`kid` pinned Trust-On-First-Use.
 *  2. The **tenant's** card, fetched through `GetExtendedAgentCard`, is what
 *     the agent row is actually about — its `displayName` comes from here.
 *
 * The second is verified against the *same* pin: one origin, one signing key,
 * so a tenant card signed by anything else is a different provider answering.
 *
 * Its declared tenant is checked too. Without that a typo'd tenant id would
 * register cleanly — the stub verifies no matter which tenant was asked for —
 * and only surface as a 401 on the first real dispatch, long after the admin
 * who could fix it has moved on.
 */
export async function verifyRemoteAgentEndpoint(
  args: VerifyRemoteAgentArgs
): Promise<VerifiedAgentCard> {
  const { endpoint, tenantId } = args;
  const allowedDomains = args.allowedDomains ?? [];

  const stub = await fetchAgentCard(endpoint, allowedDomains);
  const pin = await verifyAgentCardSignature(stub, { allowedDomains });

  const token = await args.authToken(audienceFor(endpoint), tenantId);
  const card = await fetchExtendedAgentCard(endpoint, tenantId, token);

  const tenantPin = await verifyAgentCardSignature(card, { allowedDomains });
  if (
    tenantPin.cardSigningJku !== pin.cardSigningJku ||
    tenantPin.cardSigningKid !== pin.cardSigningKid
  ) {
    throw new AgentCardVerificationError(
      `the card for tenant '${tenantId}' is signed by a different key than the ` +
        `origin's own card — one origin serves one signing identity`
    );
  }

  const declared = card.supportedInterfaces?.[0]?.tenant ?? "";
  if (declared !== tenantId) {
    throw new AgentCardVerificationError(
      `the agent returned a card declaring tenant '${declared || "<none>"}' ` +
        `for a request naming '${tenantId}'`
    );
  }

  return { pin, displayName: card.name };
}
