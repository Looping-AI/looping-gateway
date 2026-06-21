import { SignJWT, importJWK, type JWK } from "jose";
import type { UserAuthContext } from "@/auth";

/**
 * Gateway outbound identity for remote (custom) A2A agents.
 *
 * Zero-trust, no shared secrets: the gateway holds an Ed25519 private key and
 * publishes only the matching *public* JWKS (see `getPublicJwks` +
 * `/.well-known/jwks.json`). When dispatching to a remote agent it mints a
 * short-lived signed JWT; the remote verifies it against the public JWKS. This
 * proves "this request really came from the gateway" (the remote authenticates
 * the caller, A2A spec §7.4) and carries the caller's minimal identity in
 * tamper-proof claims — so it never travels as plaintext `message.metadata`.
 *
 * Algorithm is **EdDSA (Ed25519)**. The private key is a JWK stored in the
 * `GATEWAY_JWT_PRIVATE_KEY` secret; its `kid` identifies the key for rotation.
 */

/** JWS / JWT algorithm for the gateway identity. */
const ALG = "EdDSA";

/** Namespaced claim carrying the minimal, scoped caller identity. */
export const IDENTITY_CLAIM = "https://looping.ai/identity";

/** Token lifetime — short, since each dispatch mints a fresh one. */
const TOKEN_TTL_SECONDS = 120;

/**
 * The minimal identity forwarded to a remote agent. Deliberately a strict
 * subset of {@link UserAuthContext}: no permission flags or admin-workspace
 * lists cross the trust boundary — a remote agent gets who the user is, not
 * what they're allowed to do on the gateway.
 */
export interface RemoteIdentity {
  slackUserId: string;
  displayName: string | null;
  /** Workspace the routed agent belongs to (org-wide custom agents may be null). */
  workspaceId: number | null;
}

/** Project the full auth context down to the minimal cross-boundary identity. */
export function toRemoteIdentity(
  user: UserAuthContext,
  workspaceId: number | null
): RemoteIdentity {
  return {
    slackUserId: user.slackUserId,
    displayName: user.displayName,
    workspaceId
  };
}

interface SignGatewayTokenArgs {
  /** Intended recipient — the remote agent's endpoint origin. */
  audience: string;
  /**
   * This gateway's public origin — stored in D1 by the fetch isolate on first
   * request and passed in here so Workflow context (no `Request`) can sign correctly.
   */
  issuer: string;
  /** Minimal caller identity embedded under {@link IDENTITY_CLAIM}. */
  identity: RemoteIdentity;
  /** The dispatch agent kind (always `"custom"` for remote today). */
  agentKind: string;
}

type GatewayJwtEnv = Pick<Env, "GATEWAY_JWT_PRIVATE_KEY">;

/** Parse + validate the configured private JWK (throws if misconfigured). */
function privateJwk(env: GatewayJwtEnv): JWK & { kid: string } {
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
 * EdDSA; carries `iss`/`aud`/`sub`/`iat`/`exp`/`jti` plus the minimal identity
 * claim. The remote agent verifies it against the gateway's public JWKS.
 */
export async function signGatewayToken(
  env: GatewayJwtEnv,
  args: SignGatewayTokenArgs
): Promise<string> {
  const jwk = privateJwk(env);
  const { issuer } = args;
  const jwksUrl = `${issuer}/.well-known/jwks.json`;
  const key = await importJWK(jwk, ALG);

  return (
    new SignJWT({
      [IDENTITY_CLAIM]: {
        slackUserId: args.identity.slackUserId,
        displayName: args.identity.displayName,
        workspaceId: args.identity.workspaceId,
        agentKind: args.agentKind
      }
    })
      // jku (RFC 7515 §4.1.2): the URL of our public JWKS, embedded in the token so
      // remote agents can locate the verification key without separate configuration.
      .setProtectedHeader({ alg: ALG, kid: jwk.kid, typ: "JWT", jku: jwksUrl })
      .setIssuer(issuer)
      .setSubject(args.identity.slackUserId)
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
export function getPublicJwks(env: Pick<Env, "GATEWAY_JWT_PRIVATE_KEY">): {
  keys: JWK[];
} {
  const jwk = privateJwk(env as GatewayJwtEnv);
  // Strip the private scalar; publish only the public point.
  const { d: _d, ...pub } = jwk;
  void _d;
  return { keys: [{ ...pub, use: "sig", alg: ALG }] };
}
