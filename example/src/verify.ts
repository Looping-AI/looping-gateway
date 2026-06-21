import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload
} from "jose";

/**
 * Verify the gateway identity JWT (the "B authenticates A" half of zero-trust).
 *
 * The gateway signs a short-lived EdDSA JWT and sends it as a Bearer token on
 * every A2A call. Per RFC 7515 §4.1.2 it embeds a `jku` header pointing at its
 * public JWKS, so remote agents don't need a separately configured JWKS URL —
 * they read `jku` straight from the token and verify the key from there.
 *
 * Security: the `jku` origin is validated against `EXPECTED_ISSUER` before
 * fetching, preventing key-injection attacks (an attacker cannot point `jku` at
 * their own JWKS and have it accepted).
 */

/** Algorithm the gateway signs with — reject anything else. */
const ALG = "EdDSA";

/** Namespaced claim the gateway uses for the minimal caller identity. */
export const IDENTITY_CLAIM = "https://looping.ai/identity";

/** The minimal, scoped caller identity the gateway forwards. */
export interface GatewayIdentity {
  slackUserId?: string;
  displayName?: string | null;
  workspaceId?: number | null;
  agentKind?: string;
}

/** Thrown when a gateway token is missing or fails verification. */
export class GatewayAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayAuthError";
  }
}

// jose's remote JWKS helper caches keys + handles rotation; build one per URL
// and reuse it across requests in the same isolate.
const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(url: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksByUrl.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    jwksByUrl.set(url, set);
  }
  return set;
}

/** Extract the Bearer token from an `Authorization` header, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export interface VerifyOptions {
  /** The expected `iss` claim — also used to validate the `jku` domain. */
  issuer: string;
  audience: string;
}

/**
 * Verify a gateway JWT and return its payload + parsed identity.
 *
 * The `jku` JWK Set URL is read directly from the token's protected header
 * (RFC 7515 §4.1.2) and validated against `issuer` before fetching, so no
 * separate JWKS URL configuration is needed on the remote side.
 *
 * Throws {@link GatewayAuthError} on any failure.
 */
export async function verifyGatewayToken(
  token: string,
  opts: VerifyOptions
): Promise<{ payload: JWTPayload; identity: GatewayIdentity }> {
  try {
    // Extract jku from the protected header — this is the standard way the
    // gateway advertises where to fetch its public key (RFC 7515 §4.1.2).
    const header = decodeProtectedHeader(token) as { jku?: string };
    const jku = header.jku;
    if (!jku) {
      throw new GatewayAuthError(
        "gateway JWT missing jku header (RFC 7515 §4.1.2)"
      );
    }
    // Security: validate the jku origin before fetching. Without this an
    // attacker could forge a token with jku pointing at their own JWKS.
    if (new URL(jku).origin !== opts.issuer) {
      throw new GatewayAuthError(
        `jku origin '${new URL(jku).origin}' does not match expected issuer '${opts.issuer}'`
      );
    }
    const { payload } = await jwtVerify(token, jwksFor(jku), {
      issuer: opts.issuer,
      audience: opts.audience,
      algorithms: [ALG]
    });
    const identity =
      (payload[IDENTITY_CLAIM] as GatewayIdentity | undefined) ?? {};
    return { payload, identity };
  } catch (err) {
    if (err instanceof GatewayAuthError) throw err;
    throw new GatewayAuthError((err as Error).message);
  }
}
