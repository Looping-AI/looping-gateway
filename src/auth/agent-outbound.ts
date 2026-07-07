import { SignJWT, importJWK, type JWK } from "jose";
import { env } from "cloudflare:workers";

/**
 * Gateway outbound identity for remote (custom) A2A agents.
 *
 * Zero-trust, no shared secrets: the gateway holds an Ed25519 private key and
 * publishes only the matching *public* JWKS (see `getPublicJwks` +
 * `/.well-known/jwks.json`). When dispatching to a remote agent it mints a
 * short-lived signed JWT; the remote verifies it against the public JWKS. This
 * proves "this request really came from the gateway" (the remote authenticates
 * the caller, A2A spec §7.4) and carries the calling gateway-agent instance in
 * tamper-proof claims — so endpoint sharing never aliases two logical agents.
 *
 * Algorithm is **EdDSA (Ed25519)**. The private key is a JWK stored in the
 * `GATEWAY_JWT_PRIVATE_KEY` secret; its `kid` identifies the key for rotation.
 */

/** JWS / JWT algorithm for the gateway identity. */
const ALG = "EdDSA";

/** Namespaced claim carrying the signed gateway-agent caller identity. */
export const IDENTITY_CLAIM = "https://looping.ai/identity";

/** Token lifetime — short, since each dispatch mints a fresh one. */
const TOKEN_TTL_SECONDS = 120;

/**
 * Stable identity of the logical gateway-agent instance making a remote call.
 * Derived from the registered agent row, not from the endpoint URL, so two
 * distinct agents can safely share one remote service.
 */
export interface RemoteIdentity {
  /**
   * Canonical instance key used for `sub` and remote state partitioning.
   * Example: `custom:7:analytics`.
   */
  key: string;
  /** Registry name of the logical agent instance. */
  name: string;
  /** Dispatch kind of the caller (today always `"custom"` for remote agents). */
  kind: string;
  /** Workspace the registered agent belongs to. */
  workspaceId: number;
}

interface SignGatewayTokenArgs {
  /** Intended recipient — the remote agent's endpoint origin. */
  audience: string;
  /**
   * This gateway's public origin — stored in D1 by the fetch isolate on first
   * request and passed in here so Workflow context (no `Request`) can sign correctly.
   */
  issuer: string;
  /** Stable gateway-agent identity embedded under {@link IDENTITY_CLAIM}. */
  identity: RemoteIdentity;
}

/** Parse + validate the configured private JWK (throws if misconfigured). */
function privateJwk(): JWK & { kid: string } {
  const raw = env.GATEWAY_JWT_PRIVATE_KEY;
  if (!raw) {
    throw new Error("GATEWAY_JWT_PRIVATE_KEY is not configured");
  }
  let jwk: JWK;
  try {
    jwk = JSON.parse(raw) as JWK;
  } catch {
    throw new Error("GATEWAY_JWT_PRIVATE_KEY is not valid JSON");
  }
  if (!jwk.kid) {
    throw new Error("GATEWAY_JWT_PRIVATE_KEY must include a `kid`");
  }
  if (!jwk.d) {
    throw new Error(
      "GATEWAY_JWT_PRIVATE_KEY must be a private key (missing `d`)"
    );
  }
  return jwk as JWK & { kid: string };
}

/**
 * Mint a short-lived gateway identity JWT for one remote dispatch. Signed with
 * EdDSA; carries `iss`/`aud`/`sub`/`iat`/`exp`/`jti` plus the gateway-agent
 * identity claim. The remote agent verifies it against the gateway's public JWKS.
 */
export async function signGatewayToken(
  args: SignGatewayTokenArgs
): Promise<string> {
  const jwk = privateJwk();
  const { issuer } = args;
  const jwksUrl = `${issuer}/.well-known/jwks.json`;
  const key = await importJWK(jwk, ALG);

  return (
    new SignJWT({
      [IDENTITY_CLAIM]: {
        key: args.identity.key,
        name: args.identity.name,
        kind: args.identity.kind,
        workspaceId: args.identity.workspaceId
      }
    })
      // jku (RFC 7515 §4.1.2): the URL of our public JWKS, embedded in the token so
      // remote agents can locate the verification key without separate configuration.
      .setProtectedHeader({ alg: ALG, kid: jwk.kid, typ: "JWT", jku: jwksUrl })
      .setIssuer(issuer)
      .setSubject(args.identity.key)
      .setAudience(args.audience)
      .setIssuedAt()
      .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
      .setJti(crypto.randomUUID())
      .sign(key)
  );
}

/**
 * The gateway's public JWKS — the only key material ever exposed. Derived from
 * the configured private JWK by dropping the private component (`d`). Served at
 * `/.well-known/jwks.json` for remote agents to fetch and cache.
 */
export function getPublicJwks(): { keys: JWK[] } {
  const jwk = privateJwk();
  // Strip the private scalar; publish only the public point.
  const { d: _d, ...pub } = jwk;
  void _d;
  return { keys: [{ ...pub, use: "sig", alg: ALG }] };
}
