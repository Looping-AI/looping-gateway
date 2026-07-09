import { describe, it, expect, afterEach, vi } from "vitest";
import { FlattenedSign } from "jose";
import type { AgentCard } from "@a2a-js/sdk";
import {
  AgentCardVerificationError,
  canonicalCardPayload,
  verifyAgentCardSignature
} from "@/a2a/card-verify";
import { makeKey, stubJwks, type TestKey } from "../helpers/auth";

const JKU = "https://agent.example.com/.well-known/jwks.json";

function baseCard(): AgentCard {
  return {
    name: "Example",
    description: "test agent",
    protocolVersion: "0.3.0",
    version: "0.1.0",
    url: "https://agent.example.com/a2a",
    preferredTransport: "JSONRPC",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: []
  };
}

async function signCard(
  card: AgentCard,
  key: TestKey,
  jku = JKU
): Promise<AgentCard> {
  const payload = new TextEncoder().encode(canonicalCardPayload(card));
  const jws = await new FlattenedSign(payload)
    .setProtectedHeader({ alg: "EdDSA", kid: key.publicJwk.kid as string, jku })
    .sign(key.privateKey);
  return {
    ...card,
    signatures: [{ protected: jws.protected, signature: jws.signature }]
  } as AgentCard;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canonicalCardPayload", () => {
  it("strips signatures and sorts keys deterministically", () => {
    const a = canonicalCardPayload({
      name: "x",
      version: "1",
      signatures: [{ protected: "p", signature: "s" }]
    } as unknown as AgentCard);
    const b = canonicalCardPayload({
      version: "1",
      name: "x"
    } as unknown as AgentCard);
    expect(a).toBe(b);
    expect(a).toBe('{"name":"x","version":"1"}');
  });
});

describe("verifyAgentCardSignature", () => {
  it("verifies a validly signed card and returns the pin", async () => {
    const key = await makeKey("k1");
    stubJwks(JKU, [key.publicJwk]);
    const card = await signCard(baseCard(), key);

    const pin = await verifyAgentCardSignature(card, {
      allowedDomains: ["agent.example.com"]
    });
    expect(pin).toEqual({ cardSigningJku: JKU, cardSigningKid: "k1" });
  });

  it("rejects an unsigned card", async () => {
    await expect(
      verifyAgentCardSignature(baseCard(), {
        allowedDomains: ["agent.example.com"]
      })
    ).rejects.toThrow(AgentCardVerificationError);
  });

  it("rejects a tampered card body", async () => {
    const key = await makeKey("k1");
    stubJwks(JKU, [key.publicJwk]);
    const card = await signCard(baseCard(), key);
    // Mutate a signed field after signing.
    const tampered = { ...card, description: "evil" } as AgentCard;

    await expect(
      verifyAgentCardSignature(tampered, {
        allowedDomains: ["agent.example.com"]
      })
    ).rejects.toThrow(AgentCardVerificationError);
  });

  it("rejects when the signing key is absent from the JWKS (wrong kid)", async () => {
    const signer = await makeKey("real");
    const other = await makeKey("other");
    // JWKS only serves a different key id than the one in the header.
    stubJwks(JKU, [other.publicJwk]);
    const card = await signCard(baseCard(), signer);

    await expect(
      verifyAgentCardSignature(card, {
        allowedDomains: ["agent.example.com"]
      })
    ).rejects.toThrow(AgentCardVerificationError);
  });

  it("rejects a non-EdDSA protected header", async () => {
    const key = await makeKey("k1");
    stubJwks(JKU, [key.publicJwk]);
    const card = baseCard();
    const payload = new TextEncoder().encode(canonicalCardPayload(card));
    // Forge an HS256-style header (alg the verifier must refuse).
    const forged = {
      ...card,
      signatures: [
        {
          protected: Buffer.from(
            JSON.stringify({ alg: "HS256", kid: "k1", jku: JKU })
          ).toString("base64url"),
          signature: "AAAA",
          // payload intentionally omitted (detached)
          _payload: Buffer.from(payload).toString("base64url")
        }
      ]
    } as unknown as AgentCard;

    await expect(
      verifyAgentCardSignature(forged, {
        allowedDomains: ["agent.example.com"]
      })
    ).rejects.toThrow(AgentCardVerificationError);
  });
});
