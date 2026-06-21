import { describe, it, expect, afterEach, vi } from "vitest";
import { FlattenedSign, exportJWK, generateKeyPair, type JWK } from "jose";
import type { AgentCard } from "@a2a-js/sdk";
import {
  AgentCardVerificationError,
  canonicalCardPayload,
  verifyAgentCardSignature
} from "@/a2a/card-verify";

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

interface TestKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
  kid: string;
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
  return { privateKey, publicJwk, kid };
}

async function signCard(
  card: AgentCard,
  key: TestKey,
  jku = JKU
): Promise<AgentCard> {
  const payload = new TextEncoder().encode(canonicalCardPayload(card));
  const jws = await new FlattenedSign(payload)
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid, jku })
    .sign(key.privateKey);
  return {
    ...card,
    signatures: [{ protected: jws.protected, signature: jws.signature }]
  } as AgentCard;
}

/** Stub global fetch to serve a JWKS at `jku` with the given keys. */
function stubJwks(jku: string, keys: JWK[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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
      allowedHosts: ["agent.example.com"]
    });
    expect(pin).toEqual({ cardSigningJku: JKU, cardSigningKid: "k1" });
  });

  it("rejects an unsigned card", async () => {
    await expect(
      verifyAgentCardSignature(baseCard(), {
        allowedHosts: ["agent.example.com"]
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
        allowedHosts: ["agent.example.com"]
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
        allowedHosts: ["agent.example.com"]
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
        allowedHosts: ["agent.example.com"]
      })
    ).rejects.toThrow(AgentCardVerificationError);
  });
});
