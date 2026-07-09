import { describe, it, expect, afterEach, vi } from "vitest";
import {
  verifyAgentCallbackToken,
  AgentCallbackAuthError
} from "@/auth/agent-inbound";
import { makeKey, stubJwks, signJwt } from "../helpers/auth";

const JKU = "https://agent.example.com/.well-known/jwks.json";
const KID = "cb1";
const AUD = "https://gw.example.com/a2a/notifications";
const SUB = "custom:0:remote";
const DOMAINS = ["agent.example.com"];

const pin = { cardSigningJku: JKU, cardSigningKid: KID };

afterEach(() => vi.unstubAllGlobals());

describe("verifyAgentCallbackToken", () => {
  it("accepts a token signed by the pinned key with the right audience", async () => {
    const key = await makeKey(KID);
    stubJwks(JKU, [key.publicJwk]);
    const token = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

    const payload = await verifyAgentCallbackToken({
      token,
      pin,
      audience: AUD,
      allowedDomains: DOMAINS
    });
    expect(payload.aud).toBe(AUD);
    expect(payload.sub).toBe(SUB);
  });

  it("rejects a token whose audience is not our webhook", async () => {
    const key = await makeKey(KID);
    stubJwks(JKU, [key.publicJwk]);
    const token = await signJwt(key, {
      jku: JKU,
      sub: SUB,
      aud: "https://evil.example.com/hook"
    });

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
    const token = await signJwt(key, { jku: JKU, sub: SUB, aud: AUD });

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
    const token = await signJwt(attackerKey, { jku: JKU, sub: SUB, aud: AUD }); // signed by attacker

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
    const token = await signJwt(key, {
      jku: JKU,
      sub: SUB,
      aud: AUD,
      iatOffsetSec: -3600,
      expiresIn: "3h"
    });

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
