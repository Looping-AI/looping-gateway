import { describe, it, expect, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import {
  IDENTITY_CLAIM,
  getPublicJwks,
  signGatewayToken
} from "@/auth/agent-outbound";

const AUD = "https://agent.example.com";
const PUBLIC_URL = "https://gateway.test";
const EXPECTED_JKU = `${PUBLIC_URL}/.well-known/jwks.json`;

async function publicKey() {
  const { keys } = getPublicJwks();
  return importJWK(keys[0], "EdDSA");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("getPublicJwks", () => {
  it("publishes only the public Ed25519 key (no private scalar)", () => {
    const { keys } = getPublicJwks();
    expect(keys).toHaveLength(1);
    const k = keys[0] as JWK & { d?: string };
    expect(k.kty).toBe("OKP");
    expect(k.crv).toBe("Ed25519");
    expect(k.alg).toBe("EdDSA");
    expect(k.use).toBe("sig");
    expect(k.kid).toBeTruthy();
    expect(k.d).toBeUndefined();
    expect(k.x).toBeTruthy();
  });
});

describe("signGatewayToken", () => {
  it("round-trips: verifies against the public JWKS with correct claims", async () => {
    const token = await signGatewayToken({
      audience: AUD,
      issuer: PUBLIC_URL,
      identity: {
        key: "custom:7:analytics",
        name: "analytics",
        kind: "custom",
        workspaceId: 7
      }
    });

    // The protected header must carry jku pointing at our JWKS (RFC 7515 §4.1.2).
    const header = decodeProtectedHeader(token) as {
      jku?: string;
      kid?: string;
    };
    expect(header.jku).toBe(EXPECTED_JKU);
    expect(header.kid).toBeTruthy();

    const { payload } = await jwtVerify(token, await publicKey(), {
      issuer: PUBLIC_URL,
      audience: AUD,
      algorithms: ["EdDSA"]
    });
    expect(payload.iss).toBe(PUBLIC_URL);
    expect(payload.aud).toBe(AUD);
    expect(payload.sub).toBe("custom:7:analytics");
    expect(payload.jti).toBeTruthy();
    const identity = payload[IDENTITY_CLAIM] as Record<string, unknown>;
    expect(identity).toMatchObject({
      key: "custom:7:analytics",
      name: "analytics",
      kind: "custom",
      workspaceId: 7
    });
  });

  it("carries gateway-agent identity only, not user auth fields", async () => {
    const token = await signGatewayToken({
      audience: AUD,
      issuer: PUBLIC_URL,
      identity: {
        key: "custom:0:shared-endpoint",
        name: "shared-endpoint",
        kind: "custom",
        workspaceId: 0
      }
    });
    const { payload } = await jwtVerify(token, await publicKey(), {
      issuer: PUBLIC_URL,
      audience: AUD,
      algorithms: ["EdDSA"]
    });
    const identity = payload[IDENTITY_CLAIM] as Record<string, unknown>;
    expect(identity).not.toHaveProperty("slackUserId");
    expect(identity).not.toHaveProperty("displayName");
    expect(identity.workspaceId).toBe(0);
  });

  it("rejects a token presented to the wrong audience", async () => {
    const token = await signGatewayToken({
      audience: AUD,
      issuer: PUBLIC_URL,
      identity: {
        key: "custom:0:demo",
        name: "demo",
        kind: "custom",
        workspaceId: 0
      }
    });
    await expect(
      jwtVerify(token, await publicKey(), {
        issuer: PUBLIC_URL,
        audience: "https://someone-else.example.com",
        algorithms: ["EdDSA"]
      })
    ).rejects.toThrow();
  });

  it("rejects a tampered signature", async () => {
    const token = await signGatewayToken({
      audience: AUD,
      issuer: PUBLIC_URL,
      identity: {
        key: "custom:0:demo",
        name: "demo",
        kind: "custom",
        workspaceId: 0
      }
    });
    const [h, p, s] = token.split(".");
    const flipped = s[0] === "A" ? "B" : "A";
    const tampered = `${h}.${p}.${flipped}${s.slice(1)}`;
    await expect(
      jwtVerify(tampered, await publicKey(), {
        issuer: PUBLIC_URL,
        audience: AUD,
        algorithms: ["EdDSA"]
      })
    ).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const token = await signGatewayToken({
      audience: AUD,
      issuer: PUBLIC_URL,
      identity: {
        key: "custom:0:demo",
        name: "demo",
        kind: "custom",
        workspaceId: 0
      }
    });
    // Advance past the 120s TTL.
    vi.setSystemTime(new Date("2025-01-01T00:05:00Z"));
    await expect(
      jwtVerify(token, await publicKey(), {
        issuer: PUBLIC_URL,
        audience: AUD,
        algorithms: ["EdDSA"]
      })
    ).rejects.toThrow();
  });
});
