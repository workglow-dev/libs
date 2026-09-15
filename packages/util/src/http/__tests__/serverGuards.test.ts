/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import {
  assertAuthChoice,
  authorizeBearer,
  bearerTokenMatches,
  generateBearerToken,
  hostWithoutPort,
  isWildcardHost,
  readBearerToken,
  resolveAllowedHosts,
} from "../serverGuards";

describe("serverGuards", () => {
  it("allows the expected bearer and refuses everything else", () => {
    expect(authorizeBearer("Bearer abc", "abc")).toBeUndefined();
    expect(authorizeBearer("Bearer wrong", "abc")).toMatchObject({ status: 401 });
    expect(authorizeBearer(undefined, "abc")).toMatchObject({ status: 401 });
  });

  it("tells a refused client how to retry", () => {
    // Without WWW-Authenticate a 401 is a dead end: the client is not told
    // which scheme to present.
    expect(authorizeBearer(undefined, "abc")?.wwwAuthenticate).toContain("Bearer");
  });

  it("serves unauthenticated only when the host said so out loud", () => {
    expect(authorizeBearer(undefined, undefined)).toBeUndefined();
  });

  it("reads the credential case-insensitively, and only after a real separator", () => {
    expect(readBearerToken("bearer abc")).toBe("abc");
    expect(readBearerToken("Bearer\tabc")).toBe("abc");
    // RFC 9110 puts a space or tab between scheme and credential, so this
    // names no scheme this server knows.
    expect(readBearerToken("Bearerabc")).toBeUndefined();
    expect(readBearerToken("Basic abc")).toBeUndefined();
    expect(readBearerToken(undefined)).toBeUndefined();
  });

  it("does not backtrack on a header at Node's size cap", () => {
    // The quadratic spelling of this parse was measured at 380ms here.
    const header = `Bearer ${"\t".repeat(16 * 1024)}`;
    const started = performance.now();
    readBearerToken(header);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("compares tokens without leaking length through a throw", () => {
    expect(bearerTokenMatches("abc", "abc")).toBe(true);
    expect(bearerTokenMatches("ab", "abc")).toBe(false);
  });

  it("generates a token that survives a JSON config and a URL", () => {
    expect(generateBearerToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("names the bind addresses that imply no reachable host", () => {
    for (const host of ["", "0.0.0.0", "::", "[::]"]) expect(isWildcardHost(host)).toBe(true);
    expect(isWildcardHost("127.0.0.1")).toBe(false);
  });

  it("refuses an unauthenticated wildcard bind, and an unstated choice", () => {
    const server = { name: "startServer", consequence: "it runs things" };
    expect(() => assertAuthChoice(null, "0.0.0.0", server)).toThrow(/wildcard/);
    expect(() => assertAuthChoice(undefined, "127.0.0.1", server)).toThrow(/token/);
    expect(() => assertAuthChoice(null, "127.0.0.1", server)).not.toThrow();
    expect(() => assertAuthChoice("abc", "0.0.0.0", server)).not.toThrow();
  });

  it("derives a Host allow-list from a loopback bind and none from a wildcard", () => {
    expect(resolveAllowedHosts("127.0.0.1", undefined)?.has("localhost")).toBe(true);
    expect(resolveAllowedHosts("0.0.0.0", undefined)).toBeUndefined();
    expect(resolveAllowedHosts("0.0.0.0", ["Agent.Example"])?.has("agent.example")).toBe(true);
  });

  it("strips the port from a Host header, IPv6 literals included", () => {
    expect(hostWithoutPort("127.0.0.1:8788")).toBe("127.0.0.1");
    expect(hostWithoutPort("[::1]:8788")).toBe("[::1]");
    expect(hostWithoutPort(undefined)).toBe("");
  });
});
