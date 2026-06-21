import { FlattenedSign, importJWK, type JWK } from "jose";
import type { AgentCard } from "@a2a-js/sdk";
import { canonicalCardPayload } from "./canonical";

/** JWS algorithm for the card signature — must match the gateway (`EdDSA`). */
const ALG = "EdDSA";

/** The JSON-RPC path this agent answers on (the card's `url`). */
export const A2A_RPC_PATH = "/a2a";

/** An AgentCard plus the spec fields used for signing + auth advertisement. */
type SignedAgentCard = AgentCard & {
  securitySchemes?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
  signatures?: Array<{ protected: string; signature: string }>;
};

export interface CardSigningConfig {
  /** Ed25519 private JWK (with `kid`) that signs the card. */
  privateJwk: JWK & { kid: string };
  /** Public URL serving this agent's JWKS — embedded as the JWS `jku`. */
  jku: string;
}

/**
 * Build the (unsigned) AgentCard. `url` is the JSON-RPC endpoint the gateway
 * will POST to; it must be reachable at this worker's own origin. The card
 * advertises the gateway's auth scheme (HTTP Bearer JWT) so the contract is
 * self-describing, and `streaming:false` (single-reply MVP, like the gateway).
 */
export function buildBaseCard(origin: string): SignedAgentCard {
  return {
    name: "Example Echo Agent",
    description:
      "Reference remote A2A agent for looping-gateway. Verifies the gateway " +
      "identity JWT and echoes the caller's message.",
    protocolVersion: "0.3.0",
    version: "0.1.0",
    url: `${origin}${A2A_RPC_PATH}`,
    preferredTransport: "JSONRPC",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    // The gateway authenticates every call with a short-lived EdDSA JWT sent as
    // an HTTP Bearer token; advertise that so the card is self-documenting.
    securitySchemes: {
      gatewayJwt: { type: "http", scheme: "bearer", bearerFormat: "JWT" }
    },
    security: [{ gatewayJwt: [] }],
    skills: [
      {
        id: "echo",
        name: "Echo",
        description: "Echoes the caller's message back, greeting them by name.",
        tags: ["chat", "echo"]
      }
    ]
  };
}

/**
 * Sign the card with a detached-payload EdDSA flattened JWS over its canonical
 * JSON (see `canonical.ts`). The signed card carries the signature(s) in a
 * `signatures` array (A2A spec §8.4); the gateway strips that array, recomputes
 * the canonical payload, and verifies — pinning this key's `kid`+`jku` on first
 * registration (Trust-On-First-Use).
 */
export async function signCard(
  card: SignedAgentCard,
  cfg: CardSigningConfig
): Promise<SignedAgentCard> {
  const key = await importJWK(cfg.privateJwk, ALG);
  const payload = new TextEncoder().encode(
    canonicalCardPayload(card as unknown as Record<string, unknown>)
  );
  const jws = await new FlattenedSign(payload)
    .setProtectedHeader({ alg: ALG, kid: cfg.privateJwk.kid, jku: cfg.jku })
    .sign(key);
  return {
    ...card,
    signatures: [{ protected: jws.protected ?? "", signature: jws.signature }]
  };
}

/** Public card-signing JWKS (served at the `jku`): the private JWK minus `d`. */
export function publicCardJwks(privateJwk: JWK & { kid: string }): {
  keys: JWK[];
} {
  const { d: _d, ...pub } = privateJwk;
  void _d;
  return { keys: [{ ...pub, use: "sig", alg: ALG }] };
}
