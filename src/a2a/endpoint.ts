/**
 * SSRF-safe validation for remote (custom) A2A endpoints. The gateway dials
 * these URLs from inside Cloudflare, so an unvalidated endpoint is a
 * server-side request forgery vector: an attacker who can register an agent
 * could point it at internal addresses, cloud-metadata endpoints, or loopback.
 *
 * Policy (A2A spec §13.2 / §14.1.1):
 *  - HTTPS only.
 *  - Reject loopback / private / link-local / CGNAT / metadata IPv4 literals
 *    (shorthand/decimal/octal/hex forms are normalized by `new URL()` first).
 *  - Reject all IPv6 literals (see `isIPv6Literal`).
 *  - Reject bare single-label hosts and known-internal suffixes
 *    (`localhost`, `.local`, `.internal`, `.localhost`).
 *  - Optional explicit host allowlist (operator-provided).
 *
 * Residual risk: DNS rebinding. Workers cannot cheaply pre-resolve a hostname to
 * inspect the address it will actually connect to, so a public name that
 * resolves to a private address at request time is not caught here. The
 * allowlist is the mitigation when that risk is unacceptable.
 */

/** Thrown when an endpoint URL is rejected by the SSRF policy. */
export class InvalidEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEndpointError";
  }
}

/** Hostname suffixes that always resolve to internal/loopback targets. */
const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost"];

/** Exact hostnames that are always internal. */
const BLOCKED_HOSTS = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

/** Parse a dotted-quad IPv4 literal into its four octets, or null. */
function parseIPv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1, 5).map((n) => Number(n));
  if (octets.some((o) => o > 255)) return null;
  return octets as [number, number, number, number];
}

/** Private / loopback / link-local / CGNAT / reserved IPv4 ranges. */
function isBlockedIPv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (+ metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast + reserved (224.0.0.0/3)
  return false;
}

/**
 * Reject every IPv6 literal. After WHATWG URL parsing, `url.hostname` for an
 * IPv6 host is the *bracketed*, fully-compressed form (`[::1]`, `[fe80::1]`),
 * and IPv4-mapped addresses are hex-folded (`[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`).
 * Correctly classifying every special-use IPv6 range after that canonicalization
 * is error-prone, and a remote A2A endpoint never legitimately needs a bare IPv6
 * literal — a DNS hostname that happens to resolve over IPv6 is still allowed.
 * So we deny IPv6 literals outright rather than risk a parsing gap.
 */
function isIPv6Literal(host: string): boolean {
  return host.startsWith("[") || host.includes(":");
}

/** True if the host must never be dialed (internal/private/reserved). */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (isIPv6Literal(h)) return true;
  if (BLOCKED_HOSTS.has(h)) return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;

  // WHATWG `new URL()` has already canonicalized shorthand/decimal/octal/hex
  // IPv4 forms (e.g. `2130706433`, `127.1`, `0x7f.0.0.1`) to dotted-quad, so a
  // single decimal check on the canonical hostname catches all of them.
  const v4 = parseIPv4(h);
  if (v4) return isBlockedIPv4(v4);

  // Reject bare single-label hosts (no dot) — they only resolve on internal
  // search domains. IP literals are handled above, so this is hostnames only.
  if (!h.includes(".")) return true;
  return false;
}

/** Normalize an operator allowlist string (`"a.com, b.com"`) to lowercase hosts. */
export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/**
 * Validate a remote A2A endpoint against the SSRF policy. Returns the parsed
 * `URL` on success; throws {@link InvalidEndpointError} otherwise. When
 * `allowedHosts` is non-empty the endpoint host must be a member (exact match).
 */
export function validateRemoteEndpoint(
  endpoint: string,
  allowedHosts: string[] = []
): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new InvalidEndpointError(`not a valid URL: ${endpoint}`);
  }

  if (url.protocol !== "https:") {
    throw new InvalidEndpointError(
      `endpoint must use https (got ${url.protocol})`
    );
  }

  const host = url.hostname.toLowerCase();

  if (allowedHosts.length > 0) {
    if (!allowedHosts.includes(host)) {
      throw new InvalidEndpointError(`host not in allowlist: ${host}`);
    }
    return url;
  }

  if (isBlockedHost(host)) {
    throw new InvalidEndpointError(`endpoint host is not allowed: ${host}`);
  }
  return url;
}

/** The scheme+host origin of an endpoint, used as the JWT audience. */
export function originOf(endpoint: string): string {
  return new URL(endpoint).origin;
}
