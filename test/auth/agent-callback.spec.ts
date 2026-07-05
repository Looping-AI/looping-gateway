import { describe, it, expect, afterEach, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import {
  verifyAgentCallbackToken,
  AgentCallbackAuthError
} from "@/auth/agent-jwt";

const JKU = "https://agent.example.com/.well-known/jwks.json";
const KID = "cb1";
const AUD = "https://gw.example.com/a2a/notifications";
const DOMAINS = ["agent.example.com"];

interface TestKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
}

async function makeKey(kid: string): Promise<TestKey> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "EdDSA";
  publicJwk.use = "sig";
  return { privateKey, publicJwk };
}

/** Serve a JWKS at `jku`; everything else 404s. */
function stubJwks(jku: string, keys: JWK[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === jku) {
        return new Response(JSON.stringify({ keys }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    })
  );
}

async function sign(
  key: TestKey,
  opts: {
    kid?: string;
    jku?: string;
    aud?: string;
    iatOffsetSec?: number;
    expiresIn?: string;
  } = {}
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000) + (opts.iatOffsetSec ?? 0);
  return new SignJWT({})
    .setProtectedHeader({
      alg: "EdDSA",
      kid: opts.kid ?? KID,
      jku: opts.jku ?? JKU
    })
    .setSubject("custom:0:remote")
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt(iat)
    .setExpirationTime(opts.expiresIn ?? "2m")
    .sign(key.privateKey);
}

const pin = { cardSigningJku: JKU, cardSigningKid: KID };

afterEach(() => vi.unstubAllGlobals());

describe("verifyAgentCallbackToken", () => {
  it("accepts a token signed by the pinned key with the right audience", async () => {
    const key = await makeKey(KID);
    stubJwks(JKU, [key.publicJwk]);
    const token = await sign(key);

    const payload = await verifyAgentCallbackToken({
      token,
      pin,
      audience: AUD,
      allowedDomains: DOMAINS
    });
    expect(payload.aud).toBe(AUD);
    expect(payload.sub).toBe("custom:0:remote");
  });

  it("rejects a token whose audience is not our webhook", async () => {
    const key = await makeKey(KID);
    stubJwks(JKU, [key.publicJwk]);
    const token = await sign(key, { aud: "https://evil.example.com/hook" });

    await expect(
      verifyAgentCallbackToken({
        token,
        pin,
        audience: AUD,
        allowedDomains: DOMAINS
      })
    ).rejects.toThrow(AgentCallbackAuthError);
  });

  it("rejects a token whose header key does not match the pin (kid)", async () => {
    const key = await makeKey("other-kid");
    stubJwks(JKU, [key.publicJwk]);
    const token = await sign(key, { kid: "other-kid" });

    await expect(
      verifyAgentCallbackToken({
        token,
        pin,
        audience: AUD,
        allowedDomains: DOMAINS
      })
    ).rejects.toThrow(/pinned signing key/);
  });

  it("rejects a token signed by a different key than the pinned JWKS serves", async () => {
    const pinnedKey = await makeKey(KID);
    const attackerKey = await makeKey(KID); // same kid, different key material
    stubJwks(JKU, [pinnedKey.publicJwk]); // JWKS serves the real key
    const token = await sign(attackerKey); // but the token is signed by the attacker

    await expect(
      verifyAgentCallbackToken({
        token,
        pin,
        audience: AUD,
        allowedDomains: DOMAINS
      })
    ).rejects.toThrow(AgentCallbackAuthError);
  });

  it("rejects a stale token (iat too old)", async () => {
    const key = await makeKey(KID);
    stubJwks(JKU, [key.publicJwk]);
    // Issued an hour ago but still 'unexpired' — maxTokenAge must reject it.
    const token = await sign(key, { iatOffsetSec: -3600, expiresIn: "3h" });

    await expect(
      verifyAgentCallbackToken({
        token,
        pin,
        audience: AUD,
        allowedDomains: DOMAINS
      })
    ).rejects.toThrow(AgentCallbackAuthError);
  });
});
