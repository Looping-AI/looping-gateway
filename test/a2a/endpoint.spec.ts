import { describe, it, expect } from "vitest";
import {
  InvalidEndpointError,
  originOf,
  parseAllowedHosts,
  validateRemoteEndpoint
} from "@/a2a/endpoint";

describe("validateRemoteEndpoint — SSRF policy", () => {
  const accepted = [
    "https://agent.example.com",
    "https://api.example.co.uk/a2a",
    "https://sub.domain.example.org:8443/path"
  ];
  for (const endpoint of accepted) {
    it(`accepts public HTTPS host: ${endpoint}`, () => {
      const url = validateRemoteEndpoint(endpoint);
      expect(url).toBeInstanceOf(URL);
    });
  }

  const rejected: Array<[string, string]> = [
    ["http://agent.example.com", "non-https"],
    ["ftp://agent.example.com", "non-https scheme"],
    ["https://localhost/a2a", "localhost"],
    ["https://example", "bare single-label host"],
    ["https://foo.local", ".local suffix"],
    ["https://foo.internal", ".internal suffix"],
    ["https://svc.localhost", ".localhost suffix"],
    ["https://127.0.0.1", "loopback IPv4"],
    ["https://0.0.0.0", "this-host IPv4"],
    ["https://10.1.2.3", "private 10/8"],
    ["https://172.16.5.6", "private 172.16/12"],
    ["https://192.168.0.1", "private 192.168/16"],
    ["https://169.254.169.254", "link-local / metadata"],
    ["https://100.64.0.1", "CGNAT 100.64/10"],
    ["https://224.0.0.1", "multicast/reserved"],
    ["https://[::1]", "loopback IPv6"],
    ["https://[fd00::1]", "ULA IPv6"],
    ["https://[fe80::1]", "link-local IPv6"],
    ["https://[::ffff:127.0.0.1]", "IPv4-mapped loopback"],
    ["not a url", "invalid URL"]
  ];
  for (const [endpoint, why] of rejected) {
    it(`rejects ${why}: ${endpoint}`, () => {
      expect(() => validateRemoteEndpoint(endpoint)).toThrow(
        InvalidEndpointError
      );
    });
  }

  it("enforces an explicit host allowlist (exact match)", () => {
    const allow = ["agent.example.com"];
    expect(
      validateRemoteEndpoint("https://agent.example.com/a2a", allow)
    ).toBeInstanceOf(URL);
    expect(() =>
      validateRemoteEndpoint("https://evil.example.com", allow)
    ).toThrow(InvalidEndpointError);
  });
});

describe("parseAllowedHosts", () => {
  it("splits, trims, lowercases, and drops empties", () => {
    expect(parseAllowedHosts(" A.com, b.COM ,, c.com ")).toEqual([
      "a.com",
      "b.com",
      "c.com"
    ]);
  });
  it("returns [] for undefined/empty", () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts("")).toEqual([]);
  });
});

describe("originOf", () => {
  it("returns scheme+host(+port) only", () => {
    expect(originOf("https://agent.example.com/a2a?x=1")).toBe(
      "https://agent.example.com"
    );
    expect(originOf("https://agent.example.com:8443/path")).toBe(
      "https://agent.example.com:8443"
    );
  });
});
