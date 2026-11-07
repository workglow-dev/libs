/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * URL classifier used by {@link safeFetch} and {@link FetchUrlTask} to decide
 * whether a URL targets a private/internal network host.
 *
 * The classifier is browser-safe (no Node built-ins) and performs only static
 * analysis of the URL string — it does NOT perform DNS resolution. DNS-aware
 * checking + connection pinning happens in `SafeFetch.server.ts` on Node/Bun.
 */

import { resourcePatternMatches } from "./TaskEntitlements";
import ipaddr from "ipaddr.js";

export type UrlClassificationKind = "public" | "private" | "invalid";

export interface UrlClassification {
  readonly kind: UrlClassificationKind;
  /** Human-readable reason, present when kind is "private" or "invalid". */
  readonly reason?: string;
  /** Normalized hostname (lowercase, trailing dots stripped, IPv6 brackets stripped). */
  readonly host?: string;
  /** Canonical dotted-quad IPv4 / RFC5952 IPv6 if the host is a literal IP. */
  readonly literalIp?: string;
}

/** Hostnames that are always considered private regardless of DNS. */
const PRIVATE_EXACT_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata.internal",
  "metadata.azure.com",
  "instance-data",
]);

/**
 * Domain suffixes that are always considered private. Matched against the
 * normalized host with a leading dot, i.e. host === suffix OR host.endsWith("." + suffix).
 */
const PRIVATE_DOMAIN_SUFFIXES: readonly string[] = [
  "local", // mDNS / Bonjour
  "localhost", // app.localhost
  "internal", // generic internal / cloud
  "lan", // LAN
  "home.arpa", // RFC 8375
  "corp", // corporate intranet
  "intranet", // generic intranet
  "private", // generic
  "localdomain", // traditional
];

/** IP range names (from ipaddr.js) that are considered private/unsafe. */
const PRIVATE_IPV4_RANGES: ReadonlySet<string> = new Set([
  "unspecified", // 0.0.0.0/8
  "broadcast", // 255.255.255.255
  "multicast", // 224.0.0.0/4
  "linkLocal", // 169.254.0.0/16 (includes cloud metadata)
  "loopback", // 127.0.0.0/8
  "carrierGradeNat", // 100.64.0.0/10
  "private", // RFC1918 (10/8, 172.16/12, 192.168/16)
  "reserved", // 240.0.0.0/4 etc.
  "benchmarking", // 198.18.0.0/15
]);

const PRIVATE_IPV6_RANGES: ReadonlySet<string> = new Set([
  "unspecified", // ::
  "linkLocal", // fe80::/10
  "multicast", // ff00::/8
  "loopback", // ::1
  "uniqueLocal", // fc00::/7
  "ipv4Mapped", // ::ffff:0:0/96 — classified recursively below
  "ipv4Compat", // ::0:0/96
  "rfc6145", // ::ffff:0:0:0/96
  "rfc6052", // 64:ff9b::/96
  "6to4", // 2002::/16
  "teredo", // 2001::/32
  "reserved", // 2001:db8::/32 etc.
  "benchmarking", // 2001:2::/48
  "amt", // 2001:3::/32
  "as112v6", // 2001:4:112::/48
  "deprecated", // fec0::/10
  "orchid2", // 2001:20::/28
  "droneRemoteIdProtocolEntityTags", // 2001:30::/28
]);

/**
 * Accepts an IPv4 literal in any of the legacy forms accepted by inet_aton
 * (decimal, hex `0x..`, octal `0..`, and 1/2/3/4-part notation) and returns
 * its canonical dotted-quad form. Returns undefined if the host is not a
 * valid IPv4 literal in any supported form.
 *
 * Examples:
 *   "127.0.0.1"       → "127.0.0.1"
 *   "2130706433"      → "127.0.0.1"
 *   "0x7f000001"      → "127.0.0.1"
 *   "0177.0.0.1"      → "127.0.0.1"
 *   "0x7f.1"          → "127.0.0.1"
 */
export function tryNormalizeIPv4(host: string): string | undefined {
  if (host.length === 0) return undefined;

  // Fast path: already canonical dotted-quad
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const octets = host.split(".").map((s) => parseInt(s, 10));
    if (octets.every((n) => n >= 0 && n <= 255)) {
      return octets.join(".");
    }
    return undefined;
  }

  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return undefined;

  const nums: number[] = [];
  for (const p of parts) {
    if (p.length === 0) return undefined;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) {
      n = parseInt(p.slice(2), 16);
    } else if (/^0[0-7]+$/.test(p)) {
      n = parseInt(p, 8);
    } else if (/^\d+$/.test(p)) {
      n = parseInt(p, 10);
    } else {
      return undefined;
    }
    if (!Number.isFinite(n) || n < 0) return undefined;
    nums.push(n);
  }

  // Per inet_aton(3): a 1/2/3-part address packs the tail into the low bits.
  let addr: number;
  if (nums.length === 1) {
    if (nums[0] > 0xffffffff) return undefined;
    addr = nums[0];
  } else if (nums.length === 2) {
    if (nums[0] > 0xff || nums[1] > 0xffffff) return undefined;
    addr = nums[0] * 0x1000000 + nums[1];
  } else if (nums.length === 3) {
    if (nums[0] > 0xff || nums[1] > 0xff || nums[2] > 0xffff) return undefined;
    addr = nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2];
  } else {
    if (nums.some((n) => n > 0xff)) return undefined;
    addr = nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2] * 0x100 + nums[3];
  }

  const o1 = Math.floor(addr / 0x1000000) & 0xff;
  const o2 = Math.floor(addr / 0x10000) & 0xff;
  const o3 = Math.floor(addr / 0x100) & 0xff;
  const o4 = addr & 0xff;
  return `${o1}.${o2}.${o3}.${o4}`;
}

/**
 * Classifies a literal IP address (v4 or v6) as public or private.
 * Returns undefined if the address is not a valid IP literal.
 */
export function classifyIpLiteral(
  host: string
): { kind: "public" | "private"; reason?: string; canonical: string } | undefined {
  // IPv6 literal — URL.hostname already strips brackets in most runtimes.
  if (host.includes(":")) {
    let ipv6: ipaddr.IPv6;
    try {
      ipv6 = ipaddr.IPv6.parse(host);
    } catch {
      return undefined;
    }
    // IPv4-mapped IPv6 (::ffff:a.b.c.d): classify the inner v4 to catch
    // `::ffff:127.0.0.1` and similar.
    if (ipv6.isIPv4MappedAddress()) {
      const v4 = ipv6.toIPv4Address();
      const range = v4.range();
      const canonical = v4.toNormalizedString();
      if (PRIVATE_IPV4_RANGES.has(range)) {
        return { kind: "private", reason: `IPv4-mapped IPv6 in ${range} range`, canonical };
      }
      return { kind: "public", canonical };
    }
    const range = ipv6.range();
    const canonical = ipv6.toNormalizedString();
    if (PRIVATE_IPV6_RANGES.has(range)) {
      return { kind: "private", reason: `IPv6 in ${range} range`, canonical };
    }
    return { kind: "public", canonical };
  }

  // IPv4 literal (including decimal/hex/octal legacy forms)
  const canonical = tryNormalizeIPv4(host);
  if (canonical === undefined) return undefined;

  let ipv4: ipaddr.IPv4;
  try {
    ipv4 = ipaddr.IPv4.parse(canonical);
  } catch {
    return undefined;
  }
  const range = ipv4.range();
  if (PRIVATE_IPV4_RANGES.has(range)) {
    return { kind: "private", reason: `IPv4 in ${range} range`, canonical };
  }
  return { kind: "public", canonical };
}

function normalizeHost(host: string): string {
  // Strip surrounding IPv6 brackets if present (defensive — URL.hostname
  // usually already strips them).
  let h = host;
  if (h.startsWith("[") && h.endsWith("]")) {
    h = h.slice(1, -1);
  }
  // Strip trailing dot(s) — `metadata.google.internal.` → `metadata.google.internal`
  while (h.endsWith(".")) {
    h = h.slice(0, -1);
  }
  return h.toLowerCase();
}

function matchesPrivateHostnamePattern(host: string): string | undefined {
  if (PRIVATE_EXACT_HOSTS.has(host)) {
    return `host '${host}' is a reserved private name`;
  }
  for (const suffix of PRIVATE_DOMAIN_SUFFIXES) {
    if (host === suffix || host.endsWith("." + suffix)) {
      return `host matches private suffix '.${suffix}'`;
    }
  }
  return undefined;
}

/**
 * Statically classify a URL as public, private, or invalid.
 *
 * This is a pure string-level check — it does NOT perform DNS resolution.
 * For DNS-aware protection against rebinding, use {@link safeFetch}.
 */
export function classifyUrl(urlStr: string): UrlClassification {
  if (typeof urlStr !== "string" || urlStr.length === 0) {
    return { kind: "invalid", reason: "empty or non-string URL" };
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { kind: "invalid", reason: "malformed URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { kind: "invalid", reason: `unsupported protocol '${parsed.protocol}'` };
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { kind: "invalid", reason: "URL credentials are not allowed" };
  }

  const host = normalizeHost(parsed.hostname);
  if (host.length === 0) {
    return { kind: "invalid", reason: "empty host" };
  }

  const ipClassification = classifyIpLiteral(host);
  if (ipClassification !== undefined) {
    return {
      kind: ipClassification.kind,
      reason: ipClassification.reason,
      host,
      literalIp: ipClassification.canonical,
    };
  }

  const hostnameReason = matchesPrivateHostnamePattern(host);
  if (hostnameReason !== undefined) {
    return { kind: "private", reason: hostnameReason, host };
  }

  return { kind: "public", host };
}

/**
 * Returns the entitlement resource pattern for a URL, used when declaring
 * a scoped `network:private` entitlement. The pattern covers any path/query
 * under the same protocol+host(+port).
 *
 * Examples:
 *   http://localhost:3000/api    → "http://localhost:3000/*"
 *   https://192.168.1.1/admin    → "https://192.168.1.1/*"
 *   http://[::1]:8080/           → "http://[::1]:8080/*"
 */
export function urlResourcePattern(urlStr: string): string {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return urlStr;
  }
  const origin =
    parsed.port.length > 0
      ? `${parsed.protocol}//${parsed.host}`
      : `${parsed.protocol}//${parsed.hostname}`;
  return `${origin}/*`;
}

/**
 * Checks whether a (possibly post-redirect) URL falls within one of the
 * scoped resource patterns granted to the task. The URL is canonicalized so
 * minor syntactic differences (uppercase host, default port) cannot bypass the
 * check. The hostname is additionally normalized via `normalizeHost` (strips
 * trailing dots, lowercases) so that `example.internal.` and `example.internal`
 * are treated identically. Returns true when at least one pattern matches the
 * canonical URL via `resourcePatternMatches`. Returns false on URL parse errors
 * (fail closed).
 *
 * Used by `safeFetch` to enforce the task's declared `network:private`
 * resource scope on every redirect hop, preventing a compromised upstream
 * from walking across private hosts/ports via Location headers.
 */
export function urlMatchesScope(url: string, patterns: readonly string[]): boolean {
  let canonical: string;
  try {
    const parsed = new URL(url);
    parsed.hostname = normalizeHost(parsed.hostname);
    canonical = parsed.toString();
  } catch {
    return false;
  }
  return patterns.some((pat) => resourcePatternMatches(pat, canonical));
}
