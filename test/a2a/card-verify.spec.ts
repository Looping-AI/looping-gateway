import { describe, it, expect, afterEach, vi } from "vitest";
import { FlattenedSign } from "jose";
import type { AgentCard } from "@a2a-js/sdk";
import { buildAgentCard } from "@/a2a/card";
import {
  AgentCardVerificationError,
  canonicalCardPayload,
  verifyAgentCardSignature,
  verifyRemoteAgentEndpoint
} from "@/a2a/card-verify";
import { makeKey, stubJwks, type TestKey } from "../helpers/auth";

const JKU = "https://agent.example.com/.well-known/jwks.json";

function baseCard(): AgentCard {
  return buildAgentCard({
    name: "Example",
    description: "test agent",
    url: "https://agent.example.com/a2a"
  });
}

async function signCard(
  card: AgentCard,
  key: TestKey,
  jku = JKU
): Promise<AgentCard> {
  const payload = new TextEncoder().encode(canonicalCardPayload(card));
  const jws = await new FlattenedSign(payload)
    // v1.0 requires `typ` alongside `alg`/`kid` in the protected header.
    .setProtectedHeader({
      alg: "EdDSA",
      kid: key.publicJwk.kid as string,
      typ: "JOSE",
      jku
    })
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
  it("strips signatures and canonicalizes keys deterministically (JCS)", () => {
    const a = canonicalCardPayload({
      name: "x",
      version: "1",
      signatures: [{ protected: "p", signature: "s", header: undefined }]
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
            JSON.stringify({ alg: "HS256", kid: "k1", typ: "JOSE", jku: JKU })
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

/**
 * Registration, which reads **two** cards.
 *
 * The well-known path is per-authority (RFC 8615), so it serves a stub for the
 * origin and one origin has one signing key. The agent actually being
 * registered is a tenant, and its own card comes from `GetExtendedAgentCard` —
 * an authenticated call. Everything here is about the two agreeing.
 */
describe("verifyRemoteAgentEndpoint", () => {
  const ENDPOINT = "https://agent.example.com/a2a";
  const DOMAINS = ["agent.example.com"];

  const tenantCard = (tenant: string, name = "Reactive"): AgentCard => ({
    ...baseCard(),
    name,
    supportedInterfaces: [{ ...baseCard().supportedInterfaces[0], tenant }]
  });

  /** Serve a stub card at the well-known path and a tenant card over JSON-RPC. */
  function stubHost(opts: {
    stub: AgentCard;
    extended: AgentCard | { error: string };
    seen?: { authorization: string | null; tenant?: string }[];
  }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        if (request.url === JKU) {
          return Response.json({ keys: stubbedKeys });
        }
        if (request.method === "GET") {
          return Response.json(opts.stub);
        }
        const body = (await request.json()) as { params?: { tenant?: string } };
        opts.seen?.push({
          authorization: request.headers.get("authorization"),
          tenant: body.params?.tenant
        });
        return Response.json(
          "error" in opts.extended
            ? { jsonrpc: "2.0", id: 1, error: { message: opts.extended.error } }
            : { jsonrpc: "2.0", id: 1, result: opts.extended }
        );
      })
    );
  }

  let stubbedKeys: unknown[] = [];

  const verify = (tenantId: string) =>
    verifyRemoteAgentEndpoint({
      endpoint: ENDPOINT,
      tenantId,
      allowedDomains: DOMAINS,
      authToken: async () => "gw-token"
    });

  it("pins the origin's key and takes the display name from the tenant's card", async () => {
    const key = await makeKey("k1");
    stubbedKeys = [key.publicJwk];
    stubHost({
      stub: await signCard(baseCard(), key),
      extended: await signCard(tenantCard("reactive", "Reactive Agent"), key)
    });

    const verified = await verify("reactive");

    expect(verified.pin).toEqual({
      cardSigningJku: JKU,
      cardSigningKid: "k1"
    });
    // Not the stub's name — the row is about the tenant, not the origin.
    expect(verified.displayName).toBe("Reactive Agent");
  });

  it("authenticates the extended-card call and names the tenant in it", async () => {
    const key = await makeKey("k1");
    stubbedKeys = [key.publicJwk];
    const seen: { authorization: string | null; tenant?: string }[] = [];
    stubHost({
      stub: await signCard(baseCard(), key),
      extended: await signCard(tenantCard("reactive"), key),
      seen
    });

    await verify("reactive");

    expect(seen.at(-1)?.authorization).toBe("Bearer gw-token");
    expect(seen.at(-1)?.tenant).toBe("reactive");
  });

  it("rejects a card declaring a tenant other than the one asked for", async () => {
    // Without this a typo'd tenant registers cleanly — the stub verifies
    // whatever tenant was requested — and only fails on the first dispatch,
    // as a 401 far from the admin who could fix it.
    const key = await makeKey("k1");
    stubbedKeys = [key.publicJwk];
    stubHost({
      stub: await signCard(baseCard(), key),
      extended: await signCard(tenantCard("proactive"), key)
    });

    await expect(verify("reactive")).rejects.toThrow(
      /declaring tenant 'proactive'.*naming 'reactive'/
    );
  });

  it("rejects a tenant card signed by a different key than the origin's", async () => {
    // One origin, one signing key. A different signer here means something
    // other than the host that owns the well-known card answered.
    const host = await makeKey("k1");
    const other = await makeKey("k2");
    stubbedKeys = [host.publicJwk, other.publicJwk];
    stubHost({
      stub: await signCard(baseCard(), host),
      extended: await signCard(tenantCard("reactive"), other)
    });

    await expect(verify("reactive")).rejects.toThrow(
      /signed by a different key/
    );
  });

  it("surfaces the agent's refusal for an unknown tenant", async () => {
    // JSON-RPC transports errors at HTTP 200, so this is the real failure path.
    const key = await makeKey("k1");
    stubbedKeys = [key.publicJwk];
    stubHost({
      stub: await signCard(baseCard(), key),
      extended: { error: "unknown tenant 'ghost'" }
    });

    await expect(verify("ghost")).rejects.toThrow(/unknown tenant 'ghost'/);
  });
});
