import { AGENT_CARD_PATH, type AgentCard } from "@a2a-js/sdk";
import {
  base64url,
  decodeProtectedHeader,
  flattenedVerify,
  importJWK,
  type JWK
} from "jose";
import { originOf, validateRemoteEndpoint } from "./endpoint";

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
 * Signing contract (documented for third parties in `example/`): the JWS is a
 * detached-payload, EdDSA-signed flattened JWS over the **canonical JSON** of the
 * AgentCard *with its `signatures` field removed*. Canonical = `JSON.stringify`
 * with recursively sorted object keys and no insignificant whitespace.
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

/** A2A AgentCard JWS signature entry (detached payload). */
interface AgentCardSignature {
  protected: string;
  signature: string;
  header?: Record<string, unknown>;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_CARD_LENGTH = 256 * 1024;
const ALG = "EdDSA";

/** Recursively sort object keys so serialization is deterministic. */
function sortKeys(value: unknown): unknown {
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
export function canonicalCardPayload(card: AgentCard): string {
  const { signatures: _signatures, ...rest } = card as AgentCard & {
    signatures?: unknown;
  };
  void _signatures;
  return JSON.stringify(sortKeys(rest));
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
  const card = (await fetchJsonCapped(cardUrl)) as AgentCard;
  if (!card || typeof card !== "object" || typeof card.name !== "string") {
    throw new AgentCardVerificationError(`invalid AgentCard at ${cardUrl}`);
  }
  return card;
}

/** Resolve the public key referenced by a JWS `jku` + `kid`. */
async function resolveSigningKey(
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
  const signatures = (card as AgentCard & { signatures?: AgentCardSignature[] })
    .signatures;
  if (!signatures || signatures.length === 0) {
    throw new AgentCardVerificationError("AgentCard is not signed");
  }

  const payload = base64url.encode(canonicalCardPayload(card));
  const errors: string[] = [];

  for (const sig of signatures) {
    try {
      const header = decodeProtectedHeader({
        protected: sig.protected,
        signature: sig.signature,
        payload
      });
      if (header.alg !== ALG) {
        throw new Error(`unexpected alg '${header.alg ?? "none"}'`);
      }
      if (!header.kid || !header.jku) {
        throw new Error("protected header missing kid/jku");
      }
      const key = await resolveSigningKey(
        header.jku,
        header.kid,
        allowedDomains
      );
      const publicKey = await importJWK(key, ALG);
      await flattenedVerify(
        { protected: sig.protected, signature: sig.signature, payload },
        publicKey,
        { algorithms: [ALG] }
      );
      return { cardSigningJku: header.jku, cardSigningKid: header.kid };
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  throw new AgentCardVerificationError(
    `AgentCard signature verification failed: ${errors.join("; ")}`
  );
}

/**
 * One-shot verifier used at agent registration: fetch the card from the
 * endpoint, verify its signature, and return the pin plus card-derived metadata
 * (displayName) to persist alongside the agent row. The agent's avatar is NOT
 * sourced from the card — `iconUrl` is a gateway-internal, admin-generated value.
 */
export async function verifyRemoteAgentEndpoint(
  endpoint: string,
  allowedDomains: string[] = []
): Promise<VerifiedAgentCard> {
  const card = await fetchAgentCard(endpoint, allowedDomains);
  const pin = await verifyAgentCardSignature(card, { allowedDomains });
  return {
    pin,
    displayName: card.name
  };
}
