/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SSRF protection tests for FetchUrlTask — covers the URL classifier, the
 * SafeFetch DI boundary, dynamic entitlements, and end-to-end enforcement
 * through the graph runner.
 */

import { PermanentJobError, RetryableJobError } from "@workglow/job-queue";
import {
  createPolicyEnforcer,
  createProfilePolicy,
  ENTITLEMENT_ENFORCER,
  Entitlements,
  TaskEntitlementError,
  TaskGraph,
  TaskGraphRunner,
  TaskRegistry,
  type IEntitlementEnforcer,
} from "@workglow/task-graph";
import {
  classifyUrl,
  createFetchUrlJobError,
  createSafeFetchRedirectError,
  fetchUrlEntitlementsFor,
  FetchUrlErrorCode,
  FetchUrlTask,
  getSafeFetchImpl,
  isSafeFetchRedirectError,
  MAX_PRIVATE_RESOURCE_PATTERNS,
  registerSafeFetch,
  resetSafeFetch,
  safeFetch,
  urlMatchesScope,
  urlResourcePattern,
  type SafeFetchFn,
  type SafeFetchOptions,
} from "@workglow/tasks";
import {
  asText,
  Container,
  InMemoryCredentialStore,
  registerCredentialDefaults,
  ServiceRegistry,
  setGlobalCredentialStore,
  setLogger,
} from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const ok = (): Response =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const transportDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../tasks/src/util");

describe("URL classifier", () => {
  test("classifies canonical IPv4 loopback as private", () => {
    expect(classifyUrl("http://127.0.0.1/").kind).toBe("private");
    expect(classifyUrl("http://127.0.0.1:3000/api").kind).toBe("private");
  });

  test("classifies RFC1918 private IPv4 as private", () => {
    expect(classifyUrl("http://10.0.0.5/").kind).toBe("private");
    expect(classifyUrl("http://172.16.0.1/").kind).toBe("private");
    expect(classifyUrl("http://192.168.1.1/").kind).toBe("private");
  });

  test("classifies link-local metadata IP (169.254.169.254) as private", () => {
    const c = classifyUrl("http://169.254.169.254/");
    expect(c.kind).toBe("private");
    expect(c.reason).toContain("linkLocal");
  });

  test("classifies IPv4 in decimal form (inet_aton) as private", () => {
    // 2130706433 === 0x7f000001 === 127.0.0.1
    const c = classifyUrl("http://2130706433/");
    expect(c.kind).toBe("private");
    expect(c.literalIp).toBe("127.0.0.1");
  });

  test("classifies IPv4 in hex form as private", () => {
    const c = classifyUrl("http://0x7f000001/");
    expect(c.kind).toBe("private");
    expect(c.literalIp).toBe("127.0.0.1");
  });

  test("classifies IPv4 in octal form as private", () => {
    // 0177.0.0.1 — 0177 octal = 127
    const c = classifyUrl("http://0177.0.0.1/");
    expect(c.kind).toBe("private");
    expect(c.literalIp).toBe("127.0.0.1");
  });

  test("classifies IPv4 in 2-part form as private", () => {
    // 127.1 packs the tail into 24 low bits → 127.0.0.1
    const c = classifyUrl("http://127.1/");
    expect(c.kind).toBe("private");
    expect(c.literalIp).toBe("127.0.0.1");
  });

  test("classifies IPv6 loopback as private", () => {
    expect(classifyUrl("http://[::1]/").kind).toBe("private");
  });

  test("classifies IPv6 link-local and unique-local as private", () => {
    expect(classifyUrl("http://[fe80::1]/").kind).toBe("private");
    expect(classifyUrl("http://[fc00::1]/").kind).toBe("private");
  });

  test("classifies IPv4-mapped IPv6 as private (defeats the ::ffff bypass)", () => {
    const c = classifyUrl("http://[::ffff:127.0.0.1]/");
    expect(c.kind).toBe("private");
  });

  test("classifies public IPv4 as public", () => {
    expect(classifyUrl("http://8.8.8.8/").kind).toBe("public");
    expect(classifyUrl("https://1.1.1.1/").kind).toBe("public");
  });

  test("classifies public hostnames as public", () => {
    expect(classifyUrl("https://example.com/").kind).toBe("public");
    expect(classifyUrl("https://api.github.com/repos").kind).toBe("public");
  });

  test("classifies well-known private hostnames as private", () => {
    expect(classifyUrl("http://localhost/").kind).toBe("private");
    expect(classifyUrl("http://LOCALHOST/").kind).toBe("private");
    expect(classifyUrl("http://metadata.google.internal/").kind).toBe("private");
  });

  test("normalizes trailing dots (defeats the metadata.google.internal. bypass)", () => {
    expect(classifyUrl("http://metadata.google.internal./").kind).toBe("private");
    expect(classifyUrl("http://localhost./").kind).toBe("private");
  });

  test("classifies .local (mDNS) and .internal suffixes as private", () => {
    expect(classifyUrl("http://printer.local/").kind).toBe("private");
    expect(classifyUrl("http://bar.internal/").kind).toBe("private");
    expect(classifyUrl("http://api.home.arpa/").kind).toBe("private");
  });

  test("classifies file://, ftp://, etc. as invalid", () => {
    expect(classifyUrl("file:///etc/passwd").kind).toBe("invalid");
    expect(classifyUrl("ftp://example.com/").kind).toBe("invalid");
    expect(classifyUrl("gopher://example.com/").kind).toBe("invalid");
  });

  test("rejects URLs with embedded credentials", () => {
    const c = classifyUrl("http://user:pass@example.com/");
    expect(c.kind).toBe("invalid");
    expect(c.reason).toContain("credentials");
  });

  test("rejects malformed URLs", () => {
    expect(classifyUrl("").kind).toBe("invalid");
    expect(classifyUrl("not a url").kind).toBe("invalid");
    expect(classifyUrl("http://").kind).toBe("invalid");
  });
});

describe("urlResourcePattern", () => {
  test("includes port when present", () => {
    expect(urlResourcePattern("http://localhost:3000/api")).toBe("http://localhost:3000/*");
  });

  test("omits port when absent", () => {
    expect(urlResourcePattern("https://example.com/path")).toBe("https://example.com/*");
  });

  test("handles bracketed IPv6 authority", () => {
    expect(urlResourcePattern("http://[::1]:8080/x")).toBe("http://[::1]:8080/*");
  });
});

describe("SafeFetch (registration layer)", () => {
  // A classifier-driven stub impl that mirrors the default browser behaviour:
  // reject invalid + private-without-allowPrivate, otherwise return a stub OK.
  const classifyingStub: SafeFetchFn = (url, options) => {
    const c = classifyUrl(url);
    if (c.kind === "invalid") {
      return Promise.reject(new PermanentJobError(`invalid: ${c.reason}`));
    }
    if (c.kind === "private" && !options.allowPrivate) {
      return Promise.reject(new PermanentJobError(`private: ${c.reason}`));
    }
    return Promise.resolve(ok());
  };

  let prevSafeFetch: SafeFetchFn;

  beforeAll(() => {
    prevSafeFetch = registerSafeFetch(classifyingStub);
  });

  afterAll(() => {
    registerSafeFetch(prevSafeFetch);
  });

  test("rejects invalid URLs", async () => {
    await expect(safeFetch("file:///etc/passwd", {})).rejects.toThrow(/invalid/);
  });

  test("rejects private URLs when allowPrivate is false", async () => {
    await expect(safeFetch("http://127.0.0.1/", {})).rejects.toThrow(/private/);
  });

  test("allows private URLs when allowPrivate is true", async () => {
    const response = await safeFetch("http://127.0.0.1/", { allowPrivate: true });
    expect(response.status).toBe(200);
  });

  test("allows public URLs unconditionally", async () => {
    const response = await safeFetch("https://example.com/", {});
    expect(response.status).toBe(200);
  });
});

describe("urlMatchesScope", () => {
  test("matches URL against its own urlResourcePattern", () => {
    const url = "http://localhost:3000/api/v1";
    expect(urlMatchesScope(url, [urlResourcePattern(url)])).toBe(true);
  });

  test("matches deeper paths within the pattern origin", () => {
    expect(urlMatchesScope("http://localhost:3000/a/b/c", ["http://localhost:3000/*"])).toBe(true);
  });

  test("rejects different hosts", () => {
    expect(urlMatchesScope("http://192.168.1.1/admin", ["http://localhost:3000/*"])).toBe(false);
  });

  test("rejects different ports on the same host", () => {
    expect(urlMatchesScope("http://localhost:4000/api", ["http://localhost:3000/*"])).toBe(false);
  });

  test("rejects different scheme", () => {
    expect(urlMatchesScope("https://localhost:3000/api", ["http://localhost:3000/*"])).toBe(false);
  });

  test("canonicalizes host case", () => {
    // new URL().toString() lowercases the hostname — matching must respect that.
    expect(urlMatchesScope("http://LOCALHOST:3000/api", ["http://localhost:3000/*"])).toBe(true);
  });

  test("IPv6 loopback and localhost are distinct hosts", () => {
    expect(urlMatchesScope("http://[::1]:3000/", ["http://localhost:3000/*"])).toBe(false);
  });

  test("rejects hostname-prefix confusion attacks", () => {
    // `http://localhost:3000.attacker.com/` must not match `http://localhost:3000/*`.
    expect(
      urlMatchesScope("http://localhost:3000.attacker.com/", ["http://localhost:3000/*"])
    ).toBe(false);
  });

  test("matches if any one pattern in the list matches", () => {
    const patterns = ["http://localhost:3000/*", "http://127.0.0.1/*"];
    expect(urlMatchesScope("http://127.0.0.1/admin", patterns)).toBe(true);
  });

  test("empty pattern list matches nothing", () => {
    expect(urlMatchesScope("http://localhost:3000/api", [])).toBe(false);
  });

  test("unparseable URLs fail closed", () => {
    expect(urlMatchesScope("not a url", ["http://localhost:3000/*"])).toBe(false);
  });

  test("normalizes trailing-dot host (defeats the metadata.google.internal. bypass)", () => {
    expect(urlMatchesScope("http://localhost./path", ["http://localhost/*"])).toBe(true);
    expect(
      urlMatchesScope("http://metadata.google.internal./", ["http://metadata.google.internal/*"])
    ).toBe(true);
  });
});

describe("SafeFetch redirect scope enforcement (plumbing via stub)", () => {
  // A stub that mirrors the real check: honors both allowPrivate and
  // privateResourceScopes, so we can unit-test the option plumbing without
  // exercising the real redirect loop.
  const scopeAwareStub: SafeFetchFn = (url, options) => {
    const c = classifyUrl(url);
    if (c.kind === "invalid") {
      return Promise.reject(new PermanentJobError(`invalid: ${c.reason}`));
    }
    if (c.kind === "private" && !options.allowPrivate) {
      return Promise.reject(new PermanentJobError(`private: ${c.reason}`));
    }
    if (
      c.kind === "private" &&
      options.privateResourceScopes !== undefined &&
      !urlMatchesScope(url, options.privateResourceScopes)
    ) {
      return Promise.reject(new PermanentJobError(`outside granted network:private scope: ${url}`));
    }
    return Promise.resolve(ok());
  };

  let prevSafeFetch: SafeFetchFn;

  beforeAll(() => {
    prevSafeFetch = registerSafeFetch(scopeAwareStub);
  });

  afterAll(() => {
    registerSafeFetch(prevSafeFetch);
  });

  test("allows private URL within the granted scope", async () => {
    const response = await safeFetch("http://localhost:3000/api", {
      allowPrivate: true,
      privateResourceScopes: ["http://localhost:3000/*"],
    });
    expect(response.status).toBe(200);
  });

  test("rejects private URL outside the granted scope (different host)", async () => {
    await expect(
      safeFetch("http://192.168.1.1/admin", {
        allowPrivate: true,
        privateResourceScopes: ["http://localhost:3000/*"],
      })
    ).rejects.toThrow(/outside granted network:private scope/);
  });

  test("rejects private URL outside the granted scope (different port)", async () => {
    await expect(
      safeFetch("http://localhost:4000/admin", {
        allowPrivate: true,
        privateResourceScopes: ["http://localhost:3000/*"],
      })
    ).rejects.toThrow(/outside granted network:private scope/);
  });

  test("undefined privateResourceScopes preserves legacy boolean-only behavior", async () => {
    // Direct callers of safeFetch outside FetchUrlTask should not be silently
    // tightened by the new option.
    const response = await safeFetch("http://192.168.1.1/admin", {
      allowPrivate: true,
    });
    expect(response.status).toBe(200);
  });
});

describe("SafeFetch redirect scope enforcement (real redirect loop)", () => {
  // Exercise the real defaultSafeFetch redirect loop by resetting to the
  // browser impl and mocking globalThis.fetch. This verifies that the scope
  // check runs on each hop (not just the initial URL) and that redirect
  // targets are re-canonicalized through new URL() normalization.

  const redirect = (location: string, status = 302): Response =>
    new Response(null, {
      status,
      headers: { location },
    });

  let prevSafeFetch: SafeFetchFn;
  let fetchMock: ReturnType<typeof vi.fn>;
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    prevSafeFetch = getSafeFetchImpl();
    resetSafeFetch();
    realFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    registerSafeFetch(prevSafeFetch);
  });

  test("(a) in-scope redirect succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect("http://localhost:3000/api/v2"))
      .mockResolvedValueOnce(ok());
    const response = await safeFetch("http://localhost:3000/api", {
      allowPrivate: true,
      privateResourceScopes: ["http://localhost:3000/*"],
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("(b) redirect to a different private host is rejected", async () => {
    fetchMock.mockResolvedValueOnce(redirect("http://192.168.1.1/admin"));
    await expect(
      safeFetch("http://localhost:3000/api", {
        allowPrivate: true,
        privateResourceScopes: ["http://localhost:3000/*"],
      })
    ).rejects.toThrow(/outside granted network:private scope/);
    // Only the initial hop was sent; the redirect target was blocked before fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("(c) redirect to a different port on the same host is rejected", async () => {
    fetchMock.mockResolvedValueOnce(redirect("http://localhost:4000/admin"));
    await expect(
      safeFetch("http://localhost:3000/api", {
        allowPrivate: true,
        privateResourceScopes: ["http://localhost:3000/*"],
      })
    ).rejects.toThrow(/outside granted network:private scope/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("(d) public -> private redirect is still rejected (allowPrivate=false)", async () => {
    fetchMock.mockResolvedValueOnce(redirect("http://127.0.0.1/"));
    await expect(
      safeFetch("https://example.com/", {
        allowPrivate: false,
      })
    ).rejects.toThrow(/private\/internal URL/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("(e) redirect from localhost:3000 to [::1]:3000 is rejected", async () => {
    fetchMock.mockResolvedValueOnce(redirect("http://[::1]:3000/"));
    await expect(
      safeFetch("http://localhost:3000/api", {
        allowPrivate: true,
        privateResourceScopes: ["http://localhost:3000/*"],
      })
    ).rejects.toThrow(/outside granted network:private scope/);
  });

  test("(f) chained in-scope redirects all resolve", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect("http://localhost:3000/api/v2"))
      .mockResolvedValueOnce(redirect("http://localhost:3000/api/v3"))
      .mockResolvedValueOnce(ok());
    const response = await safeFetch("http://localhost:3000/api", {
      allowPrivate: true,
      privateResourceScopes: ["http://localhost:3000/*"],
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("(g) uppercase-host redirect target is normalized and accepted", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect("HTTP://LOCALHOST:3000/api/v2"))
      .mockResolvedValueOnce(ok());
    const response = await safeFetch("http://localhost:3000/api", {
      allowPrivate: true,
      privateResourceScopes: ["http://localhost:3000/*"],
    });
    expect(response.status).toBe(200);
  });

  test("(h) undefined privateResourceScopes preserves legacy behavior", async () => {
    // Direct callers outside FetchUrlTask should keep the boolean-only semantics.
    fetchMock
      .mockResolvedValueOnce(redirect("http://192.168.1.1/admin"))
      .mockResolvedValueOnce(ok());
    const response = await safeFetch("http://localhost:3000/api", {
      allowPrivate: true,
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("defaultSafeFetch cross-origin redirect header strip", () => {
  // The browser implementation is a second, independent redirect loop: a fix in
  // SafeFetch.server.ts is not a fix here. These exercise the real
  // defaultSafeFetch by resetting to it and mocking globalThis.fetch, and all of
  // them use PUBLIC origins — `privateResourceScopes` never applies there, so
  // the header strip is the only thing standing between a compromised vendor
  // and the caller's credential.

  const redirect = (location: string, status = 302): Response =>
    new Response(null, { status, headers: { location } });

  let prevSafeFetch: SafeFetchFn;
  let fetchMock: ReturnType<typeof vi.fn>;
  let realFetch: typeof globalThis.fetch;

  /** Headers the mock received on call `index` (0-based), keyed lower-case. */
  const headersOnCall = (index: number): Record<string, string> => {
    const init = fetchMock.mock.calls[index]?.[1] as { headers?: Record<string, string> };
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(init?.headers ?? {})) {
      out[key.toLowerCase()] = value;
    }
    return out;
  };

  /** The body the mock received on call `index` (0-based). */
  const bodyOnCall = (index: number): unknown =>
    (fetchMock.mock.calls[index]?.[1] as { body?: unknown } | undefined)?.body;

  /** The method the mock received on call `index` (0-based). */
  const methodOnCall = (index: number): string | undefined =>
    (fetchMock.mock.calls[index]?.[1] as { method?: string } | undefined)?.method;

  /** A body carrying a secret that must never reach a redirect target. */
  const SECRET_BODY = JSON.stringify({ client_secret: "sk-body-secret-1234567890" });

  beforeEach(() => {
    prevSafeFetch = getSafeFetchImpl();
    resetSafeFetch();
    realFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    registerSafeFetch(prevSafeFetch);
  });

  test("cross-origin 302 drops Authorization and keeps unrelated headers", async () => {
    // The finding itself: without the strip the attacker origin receives the
    // bearer token. The surviving X-Trace-Id proves the strip is targeted.
    fetchMock
      .mockResolvedValueOnce(redirect("https://attacker.example/"))
      .mockResolvedValueOnce(ok());

    await safeFetch("https://api.vendor.example/x", {
      headers: { Authorization: "Bearer super-secret-token", "X-Trace-Id": "trace-1" },
    });

    expect(headersOnCall(0).authorization).toBe("Bearer super-secret-token");
    expect(headersOnCall(1).authorization).toBeUndefined();
    expect(headersOnCall(1)["x-trace-id"]).toBe("trace-1");
  });

  test("same-origin 302 keeps Authorization", async () => {
    // Guards the opposite failure: an unconditional strip would break every
    // authenticated API that redirects within its own origin.
    fetchMock
      .mockResolvedValueOnce(redirect("https://api.vendor.example/x/v2"))
      .mockResolvedValueOnce(ok());

    await safeFetch("https://api.vendor.example/x", {
      headers: { Authorization: "Bearer super-secret-token" },
    });

    expect(headersOnCall(1).authorization).toBe("Bearer super-secret-token");
  });

  test("a sensitiveHeaders-named custom header is dropped cross-origin", async () => {
    // credential_scheme "header" puts the secret on a caller-chosen header that
    // safeFetch cannot recognize on its own.
    fetchMock
      .mockResolvedValueOnce(redirect("https://attacker.example/"))
      .mockResolvedValueOnce(ok());

    await safeFetch("https://api.vendor.example/x", {
      headers: { "X-Api-Key": "sk-secret", "X-Trace-Id": "trace-1" },
      sensitiveHeaders: ["x-api-key"],
    });

    expect(headersOnCall(1)["x-api-key"]).toBeUndefined();
    expect(headersOnCall(1)["x-trace-id"]).toBe("trace-1");
  });

  test("a differing port on the same host counts as cross-origin", async () => {
    // A hostname comparison would call these same-origin and replay the token.
    fetchMock
      .mockResolvedValueOnce(redirect("https://api.vendor.example:8443/x"))
      .mockResolvedValueOnce(ok());

    await safeFetch("https://api.vendor.example/x", {
      headers: { Authorization: "Bearer super-secret-token" },
    });

    expect(headersOnCall(1).authorization).toBeUndefined();
  });

  test("a differing scheme on the same host counts as cross-origin", async () => {
    // https -> http is a downgrade onto the wire; the token must not follow.
    fetchMock
      .mockResolvedValueOnce(redirect("http://api.vendor.example/x"))
      .mockResolvedValueOnce(ok());

    await safeFetch("https://api.vendor.example/x", {
      headers: { Authorization: "Bearer super-secret-token" },
    });

    expect(headersOnCall(1).authorization).toBeUndefined();
  });

  test("cookie and proxy-authorization are dropped with no sensitiveHeaders supplied", async () => {
    // The fixed strip-set must not depend on the caller opting in.
    fetchMock
      .mockResolvedValueOnce(redirect("https://attacker.example/"))
      .mockResolvedValueOnce(ok());

    await safeFetch("https://api.vendor.example/x", {
      headers: { Cookie: "session=abc123", "Proxy-Authorization": "Basic cHJveHk6cHc=" },
    });

    expect(headersOnCall(1).cookie).toBeUndefined();
    expect(headersOnCall(1)["proxy-authorization"]).toBeUndefined();
  });

  test("a Headers instance is stripped too, not just a plain record", async () => {
    // Direct callers may pass any HeadersInit shape; a record-only strip would
    // pass a Headers object straight through to the attacker origin.
    fetchMock
      .mockResolvedValueOnce(redirect("https://attacker.example/"))
      .mockResolvedValueOnce(ok());

    await safeFetch("https://api.vendor.example/x", {
      headers: new Headers({ Authorization: "Bearer super-secret-token", Accept: "text/plain" }),
    });

    const sent = fetchMock.mock.calls[1]?.[1] as { headers?: Headers };
    expect(sent?.headers).toBeInstanceOf(Headers);
    expect(sent!.headers!.get("authorization")).toBeNull();
    expect(sent!.headers!.get("accept")).toBe("text/plain");
  });

  test("once stripped the header stays stripped when the chain returns home", async () => {
    // Laundering guard: vendor -> attacker -> vendor must not restore the token
    // on the final hop merely because that origin matches the original.
    fetchMock
      .mockResolvedValueOnce(redirect("https://attacker.example/bounce"))
      .mockResolvedValueOnce(redirect("https://api.vendor.example/final"))
      .mockResolvedValueOnce(ok());

    await safeFetch("https://api.vendor.example/x", {
      headers: { Authorization: "Bearer super-secret-token" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://api.vendor.example/final");
    expect(headersOnCall(2).authorization).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Method / body handling across a redirect. Stripping the credential HEADER
  // does nothing for a credential in the request BODY: a POST carrying
  // `client_secret` was re-POSTed verbatim to whatever origin the Location
  // named.
  // -------------------------------------------------------------------------

  test("a 303 downgrades a POST to a bodiless GET and drops the body headers", async () => {
    // RFC 9110: 303 means "fetch the result with GET". Leaving Content-Length
    // on a request that now has no body makes the transport state a length no
    // body satisfies.
    fetchMock
      .mockResolvedValueOnce(redirect("https://attacker.example/", 303))
      .mockResolvedValueOnce(ok());

    await safeFetch("https://api.vendor.example/x", {
      method: "POST",
      body: SECRET_BODY,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(SECRET_BODY.length),
        "X-Trace-Id": "trace-1",
      },
    });

    expect(methodOnCall(1)).toBe("GET");
    expect(bodyOnCall(1)).toBeUndefined();
    expect(headersOnCall(1)["content-type"]).toBeUndefined();
    expect(headersOnCall(1)["content-length"]).toBeUndefined();
    // Targeted, not a blanket wipe.
    expect(headersOnCall(1)["x-trace-id"]).toBe("trace-1");
  });

  test("a cross-origin 302 on a POST downgrades to a bodiless GET", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect("https://attacker.example/", 302))
      .mockResolvedValueOnce(ok());

    await safeFetch("https://api.vendor.example/x", {
      method: "POST",
      body: SECRET_BODY,
      headers: { "Content-Type": "application/json" },
    });

    expect(methodOnCall(1)).toBe("GET");
    expect(bodyOnCall(1)).toBeUndefined();
    expect(headersOnCall(1)["content-type"]).toBeUndefined();
  });

  test("a same-origin 302 on a POST downgrades to a bodiless GET too", async () => {
    // The POST -> GET rewrite is not a cross-origin defense, it is what the
    // Fetch spec, browsers, curl -L and undici's own follow mode all do.
    fetchMock
      .mockResolvedValueOnce(redirect("https://api.vendor.example/x/v2", 302))
      .mockResolvedValueOnce(ok());

    await safeFetch("https://api.vendor.example/x", {
      method: "POST",
      body: SECRET_BODY,
      headers: { "Content-Type": "application/json" },
    });

    expect(methodOnCall(1)).toBe("GET");
    expect(bodyOnCall(1)).toBeUndefined();
  });

  test("a cross-origin 307 carrying a body is refused rather than replayed", async () => {
    // 307/308 preserve method and body by definition, so there is no downgrade
    // that still performs the caller's write. Refusing is the only answer that
    // neither leaks the body nor reports a write that never happened.
    fetchMock.mockResolvedValueOnce(redirect("https://attacker.example/", 307));

    const error = await safeFetch("https://api.vendor.example/x", {
      method: "POST",
      body: SECRET_BODY,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PermanentJobError);
    expect((error as { code?: string }).code).toBe(FetchUrlErrorCode.REDIRECT_BODY_NOT_REPLAYED);
    // The refusal happens before the second hop is issued at all.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a same-origin 307 still replays method and body", async () => {
    // Anti-regression: refusing every 307 would break same-origin APIs that
    // redirect a write within their own origin.
    fetchMock
      .mockResolvedValueOnce(redirect("https://api.vendor.example/x/v2", 307))
      .mockResolvedValueOnce(ok());

    await safeFetch("https://api.vendor.example/x", {
      method: "POST",
      body: SECRET_BODY,
      headers: { "Content-Type": "application/json" },
    });

    expect(methodOnCall(1)).toBe("POST");
    expect(bodyOnCall(1)).toBe(SECRET_BODY);
    expect(headersOnCall(1)["content-type"]).toBe("application/json");
  });

  for (const status of [301, 302, 303] as const) {
    test(`a ${status} never replays the request body to the redirect target`, async () => {
      fetchMock
        .mockResolvedValueOnce(redirect("https://attacker.example/", status))
        .mockResolvedValueOnce(ok());

      await safeFetch("https://api.vendor.example/x", {
        method: "POST",
        body: SECRET_BODY,
        headers: { "Content-Type": "application/json" },
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(asText(bodyOnCall(1) ?? "")).not.toContain("client_secret");
      expect(JSON.stringify(fetchMock.mock.calls[1])).not.toContain("client_secret");
    });
  }

  test("a 303 on a GET stays a bodiless GET", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect("https://api.vendor.example/x/v2", 303))
      .mockResolvedValueOnce(ok());

    await safeFetch("https://api.vendor.example/x");

    expect(methodOnCall(1)).toBe("GET");
    expect(bodyOnCall(1)).toBeUndefined();
  });
});

describe("FetchUrlTask end-to-end: a resolved credential never reaches a redirect target", () => {
  // The whole path is real here — credential resolution, header placement,
  // FetchUrlJob, and the defaultSafeFetch redirect loop — with only the socket
  // mocked. Public origins are used deliberately: the private-scope guard does
  // not apply to them, so nothing but the header strip protects the secret.
  const SECRET = "sk-super-secret-value-1234567890";
  const CREDENTIAL_KEY = "vendor-api-credential";

  const redirect = (location: string): Response =>
    new Response(null, { status: 302, headers: { location } });

  let prevSafeFetch: SafeFetchFn;
  let fetchMock: ReturnType<typeof vi.fn>;
  let realFetch: typeof globalThis.fetch;

  const createCredentialRegistry = async (): Promise<ServiceRegistry> => {
    const credentialRegistry = new ServiceRegistry(new Container());
    registerCredentialDefaults(credentialRegistry);
    const store = new InMemoryCredentialStore();
    await store.put(CREDENTIAL_KEY, SECRET);
    setGlobalCredentialStore(store, credentialRegistry);
    return credentialRegistry;
  };

  /** Every header value the mock ever received, flattened for a secret scan. */
  const allSentHeaderValues = (): string[] =>
    fetchMock.mock.calls.flatMap((call) => {
      const init = call[1] as { headers?: Record<string, string> };
      return Object.values(init?.headers ?? {});
    });

  beforeEach(() => {
    prevSafeFetch = getSafeFetchImpl();
    resetSafeFetch();
    realFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    registerSafeFetch(prevSafeFetch);
  });

  test("a bearer credential is not replayed to a cross-origin redirect target", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect("https://attacker.example/"))
      .mockResolvedValueOnce(ok());

    const credentialRegistry = await createCredentialRegistry();
    await new FetchUrlTask().run(
      { url: "https://api.vendor.example/x", credential_key: CREDENTIAL_KEY },
      { registry: credentialRegistry }
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://attacker.example/");
    const attackerInit = fetchMock.mock.calls[1]?.[1] as { headers?: Record<string, string> };
    expect(JSON.stringify(attackerInit?.headers ?? {})).not.toContain(SECRET);
    // The vendor origin did receive it — otherwise this would pass on a
    // credential that was never applied to the request in the first place.
    expect(JSON.stringify(fetchMock.mock.calls[0]?.[1])).toContain(SECRET);
  });

  test("a credential_scheme 'header' secret is not replayed either", async () => {
    // This is the case that forced the SafeFetchOptions API change: the secret
    // sits on X-Api-Key, a name the redirect loop cannot infer from the request.
    fetchMock
      .mockResolvedValueOnce(redirect("https://attacker.example/"))
      .mockResolvedValueOnce(ok());

    const credentialRegistry = await createCredentialRegistry();
    await new FetchUrlTask().run(
      {
        url: "https://api.vendor.example/x",
        credential_key: CREDENTIAL_KEY,
        credential_scheme: "header",
        credential_header: "X-Api-Key",
      },
      { registry: credentialRegistry }
    );

    const attackerInit = fetchMock.mock.calls[1]?.[1] as { headers?: Record<string, string> };
    expect(attackerInit?.headers?.["X-Api-Key"]).toBeUndefined();
    expect(allSentHeaderValues().filter((value) => value.includes(SECRET))).toHaveLength(1);
  });
});

describe("FetchUrlJob threads privateResourceScopes from declared entitlement scope", () => {
  // Verifies that the FetchUrlJob execution path passes the same scope to
  // safeFetch that FetchUrlTask.entitlements() declares — so the preflight
  // and runtime checks cannot drift.
  let prevSafeFetch: SafeFetchFn;
  let capturedOptions: SafeFetchOptions | undefined;

  beforeEach(() => {
    capturedOptions = undefined;
    prevSafeFetch = registerSafeFetch((_url, options) => {
      capturedOptions = options;
      return Promise.resolve(ok());
    });
  });

  afterEach(() => {
    registerSafeFetch(prevSafeFetch);
  });

  test("private URL input passes privateResourceScopes matching urlResourcePattern", async () => {
    const url = "http://localhost:3000/api";
    const task = new FetchUrlTask({ queue: false });
    await task.run({ url });
    expect(capturedOptions?.allowPrivate).toBe(true);
    expect(capturedOptions?.privateResourceScopes).toEqual([urlResourcePattern(url)]);
    expect(capturedOptions?.privateResourceScopes).toEqual(["http://localhost:3000/*"]);
  });

  test("public URL input does not pass privateResourceScopes", async () => {
    const task = new FetchUrlTask({ queue: false });
    await task.run({ url: "https://example.com/" });
    expect(capturedOptions?.allowPrivate).toBe(false);
    expect(capturedOptions?.privateResourceScopes).toBeUndefined();
  });
});

describe("FetchUrlTask dynamic entitlements", () => {
  test("declares only network:http for public URLs", () => {
    const task = new FetchUrlTask();
    task.setInput({ url: "https://example.com/" });
    const result = task.entitlements();
    const ids = result.entitlements.map((e) => e.id);
    expect(ids).toContain(Entitlements.NETWORK_HTTP);
    expect(ids).not.toContain(Entitlements.NETWORK_PRIVATE);
  });

  test("adds network:private for loopback URLs, scoped to the URL origin", () => {
    const task = new FetchUrlTask();
    task.setInput({ url: "http://localhost:3000/api" });
    const result = task.entitlements();
    const privateEnt = result.entitlements.find((e) => e.id === Entitlements.NETWORK_PRIVATE);
    expect(privateEnt).toBeDefined();
    expect(privateEnt?.resources).toEqual(["http://localhost:3000/*"]);
  });

  test("adds network:private for RFC1918 IPs", () => {
    const task = new FetchUrlTask();
    task.setInput({ url: "http://192.168.1.1/admin" });
    const result = task.entitlements();
    const ids = result.entitlements.map((e) => e.id);
    expect(ids).toContain(Entitlements.NETWORK_PRIVATE);
  });

  test("adds network:private for cloud metadata IP", () => {
    const task = new FetchUrlTask();
    task.setInput({ url: "http://169.254.169.254/" });
    const result = task.entitlements();
    const ids = result.entitlements.map((e) => e.id);
    expect(ids).toContain(Entitlements.NETWORK_PRIVATE);
  });

  test("requires network:private when URL input is missing (fail-closed)", () => {
    const task = new FetchUrlTask();
    const result = task.entitlements();
    const ids = result.entitlements.map((e) => e.id);
    expect(ids).toContain(Entitlements.NETWORK_HTTP);
    // Fail-closed: require network:private when URL is not yet known at entitlement
    // evaluation time, so a policy grant is needed before any private access can happen.
    expect(ids).toContain(Entitlements.NETWORK_PRIVATE);
  });

  test("scopes network:private across an array of private URLs", () => {
    // MapTask projection seeds the inner fetch with the whole url[] rather than
    // one scalar per iteration. Classifying the array must union per-host
    // scopes — treating a non-string as "unknown" would declare unscoped
    // network:private, which a loopback-only grant cannot cover.
    const result = fetchUrlEntitlementsFor([
      "http://localhost:5173/raw/a.mdx",
      "http://localhost:5173/raw/b.mdx",
    ]);
    const privateEnt = result.entitlements.find((e) => e.id === Entitlements.NETWORK_PRIVATE);
    expect(privateEnt).toBeDefined();
    expect(privateEnt?.resources).toEqual(["http://localhost:5173/*"]);
  });

  test("does not declare network:private for an array of public URLs", () => {
    const result = fetchUrlEntitlementsFor(["https://example.com/a", "https://example.com/b"]);
    expect(result.entitlements.map((e) => e.id)).not.toContain(Entitlements.NETWORK_PRIVATE);
  });

  test("scopes only the private hosts in a mixed array", () => {
    const result = fetchUrlEntitlementsFor([
      "https://example.com/a",
      "http://localhost:5173/raw/b.mdx",
    ]);
    const privateEnt = result.entitlements.find((e) => e.id === Entitlements.NETWORK_PRIVATE);
    expect(privateEnt?.resources).toEqual(["http://localhost:5173/*"]);
  });

  test("fail-closes when any array entry is not a usable URL", () => {
    const result = fetchUrlEntitlementsFor(["http://localhost:5173/a.mdx", ""]);
    const privateEnt = result.entitlements.find((e) => e.id === Entitlements.NETWORK_PRIVATE);
    expect(privateEnt).toBeDefined();
    expect(privateEnt?.resources).toBeUndefined();
  });

  test("dedupes repeated origins rather than one resource per URL", () => {
    // A blog index is hundreds of paths on ONE dev-server origin. The scope is
    // per-origin, so the declaration stays a single pattern however long the
    // array is — and stays well under the distinct-host ceiling below.
    const urls = Array.from({ length: 500 }, (_, i) => `http://localhost:5173/raw/post-${i}.mdx`);
    const privateEnt = fetchUrlEntitlementsFor(urls).entitlements.find(
      (e) => e.id === Entitlements.NETWORK_PRIVATE
    );
    expect(privateEnt?.resources).toEqual(["http://localhost:5173/*"]);
  });

  test("scopes up to the distinct private origin ceiling", () => {
    const urls = Array.from(
      { length: MAX_PRIVATE_RESOURCE_PATTERNS },
      (_, i) => `http://10.0.0.${i}/x`
    );
    const privateEnt = fetchUrlEntitlementsFor(urls).entitlements.find(
      (e) => e.id === Entitlements.NETWORK_PRIVATE
    );
    expect(privateEnt?.resources).toHaveLength(MAX_PRIVATE_RESOURCE_PATTERNS);
  });

  test("fail-closes past the distinct private origin ceiling", () => {
    // Run input is caller-shaped: an array naming more private hosts than a
    // reviewer can read collapses to the unscoped declaration rather than
    // producing an unbounded resource list. Widening is the safe direction.
    const urls = Array.from(
      { length: MAX_PRIVATE_RESOURCE_PATTERNS + 1 },
      (_, i) => `http://10.0.0.${i}/x`
    );
    const privateEnt = fetchUrlEntitlementsFor(urls).entitlements.find(
      (e) => e.id === Entitlements.NETWORK_PRIVATE
    );
    expect(privateEnt).toBeDefined();
    expect(privateEnt?.resources).toBeUndefined();
  });
});

describe("FetchUrlTask end-to-end entitlement enforcement", () => {
  const logger = getTestingLogger();
  setLogger(logger);

  let prevSafeFetch: SafeFetchFn;

  beforeAll(() => {
    // Stub safeFetch to always return success — we're testing the enforcer,
    // not the network layer.
    prevSafeFetch = registerSafeFetch(() => Promise.resolve(ok()));
    TaskRegistry.registerTask(FetchUrlTask);
  });

  afterAll(() => {
    registerSafeFetch(prevSafeFetch);
  });

  function makeRegistry(enforcer: IEntitlementEnforcer): ServiceRegistry {
    const registry = new ServiceRegistry(new Container());
    registry.register(ENTITLEMENT_ENFORCER, () => enforcer);
    return registry;
  }

  function makeGraphForUrl(url: string): TaskGraph {
    const graph = new TaskGraph();
    graph.addTask(new FetchUrlTask({ id: "fetch-node", queue: false, defaults: { url } }));
    return graph;
  }

  test("browser profile denies private URL (network:private not granted)", async () => {
    const enforcer = createPolicyEnforcer(createProfilePolicy("browser"));
    const registry = makeRegistry(enforcer);
    const runner = new TaskGraphRunner(makeGraphForUrl("http://localhost:3000/api"));
    await expect(runner.runGraph({}, { registry, enforceEntitlements: true })).rejects.toThrow(
      TaskEntitlementError
    );
  });

  test("browser profile allows public URL", async () => {
    const enforcer = createPolicyEnforcer(createProfilePolicy("browser"));
    const registry = makeRegistry(enforcer);
    const runner = new TaskGraphRunner(makeGraphForUrl("https://example.com/"));
    await expect(
      runner.runGraph({}, { registry, enforceEntitlements: true })
    ).resolves.toBeDefined();
  });

  test("dev-augmented browser profile allows loopback-scoped network:private", async () => {
    const browserPolicy = createProfilePolicy("browser");
    const devEnforcer = createPolicyEnforcer({
      deny: browserPolicy.deny,
      grant: [
        ...browserPolicy.grant,
        {
          id: Entitlements.NETWORK_PRIVATE,
          resources: [
            "http://localhost/*",
            "http://localhost:*",
            "http://127.0.0.1/*",
            "http://127.0.0.1:*",
          ],
        },
      ],
      ask: browserPolicy.ask,
    });
    const registry = makeRegistry(devEnforcer);
    const runner = new TaskGraphRunner(makeGraphForUrl("http://localhost:3000/api"));
    await expect(
      runner.runGraph({}, { registry, enforceEntitlements: true })
    ).resolves.toBeDefined();
  });

  test("dev grant scoped to localhost does NOT cover LAN (192.168.x)", async () => {
    const browserPolicy = createProfilePolicy("browser");
    const devEnforcer = createPolicyEnforcer({
      deny: browserPolicy.deny,
      grant: [
        ...browserPolicy.grant,
        {
          id: Entitlements.NETWORK_PRIVATE,
          resources: ["http://localhost/*", "http://localhost:*", "http://127.0.0.1/*"],
        },
      ],
      ask: browserPolicy.ask,
    });
    const registry = makeRegistry(devEnforcer);
    const runner = new TaskGraphRunner(makeGraphForUrl("http://192.168.1.1/admin"));
    await expect(runner.runGraph({}, { registry, enforceEntitlements: true })).rejects.toThrow(
      TaskEntitlementError
    );
  });
});

// A 3xx answered under `redirect: "error"` is a refusal both transports have
// to raise identically, and that consumers have to recognize WITHOUT reading
// the message: `postWebhookJson` maps it to a permanent error, and its generic
// fallback branch is retryable, so a refusal a consumer fails to recognize
// silently becomes a retried request.
describe("SafeFetch redirect refusal sentinel", () => {
  const REQUESTED = "http://localhost:3000/hook";
  const REDIRECT_TARGET = "https://attacker.example/collect";

  const redirectTo = (location: string, status = 302): Response =>
    new Response(null, { status, headers: { location } });

  describe("isSafeFetchRedirectError", () => {
    test("accepts the refusal the transports build", () => {
      expect(isSafeFetchRedirectError(createSafeFetchRedirectError(REQUESTED, 302))).toBe(true);
    });

    test("rejects an ordinary TypeError, including one that names a redirect", () => {
      expect(isSafeFetchRedirectError(new TypeError("connect ECONNREFUSED"))).toBe(false);
      expect(isSafeFetchRedirectError(new TypeError("fetch failed: too many redirect hops"))).toBe(
        false
      );
    });

    test("rejects every other FetchUrlJobError, including the neighbouring redirect codes", () => {
      expect(
        isSafeFetchRedirectError(
          createFetchUrlJobError(FetchUrlErrorCode.REDIRECT_MISSING_LOCATION, "no location")
        )
      ).toBe(false);
      expect(
        isSafeFetchRedirectError(
          createFetchUrlJobError(FetchUrlErrorCode.TOO_MANY_REDIRECTS, "too many")
        )
      ).toBe(false);
      expect(
        isSafeFetchRedirectError(createFetchUrlJobError(FetchUrlErrorCode.NETWORK_ERROR, "boom"))
      ).toBe(false);
    });

    test("rejects non-Error values without throwing", () => {
      expect(isSafeFetchRedirectError(undefined)).toBe(false);
      expect(isSafeFetchRedirectError(null)).toBe(false);
      expect(isSafeFetchRedirectError("redirect")).toBe(false);
      expect(isSafeFetchRedirectError({ code: FetchUrlErrorCode.REDIRECT_NOT_FOLLOWED })).toBe(
        false
      );
    });
  });

  test("the refusal is permanent and carries the request URL and 3xx status", () => {
    const error = createSafeFetchRedirectError(REQUESTED, 307);
    expect(error).toBeInstanceOf(PermanentJobError);
    expect(error).not.toBeInstanceOf(RetryableJobError);
    expect(error.code).toBe(FetchUrlErrorCode.REDIRECT_NOT_FOLLOWED);
    expect(error.url).toBe(REQUESTED);
    expect(error.httpStatus).toBe(307);
  });

  describe("browser transport", () => {
    let prevSafeFetch: SafeFetchFn;
    let fetchMock: ReturnType<typeof vi.fn>;
    let realFetch: typeof globalThis.fetch;

    beforeEach(() => {
      prevSafeFetch = getSafeFetchImpl();
      resetSafeFetch();
      realFetch = globalThis.fetch;
      fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
      registerSafeFetch(prevSafeFetch);
    });

    test("throws the sentinel for a 3xx and never issues the redirected request", async () => {
      fetchMock.mockResolvedValueOnce(redirectTo(REDIRECT_TARGET));

      const error = await safeFetch(REQUESTED, {
        allowPrivate: true,
        redirect: "error",
      }).catch((e: unknown) => e);

      expect(isSafeFetchRedirectError(error)).toBe(true);
      expect((error as { httpStatus?: number }).httpStatus).toBe(302);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("neither the message nor the stack names the Location it refused", async () => {
      fetchMock.mockResolvedValueOnce(redirectTo(REDIRECT_TARGET, 301));

      const error = (await safeFetch(REQUESTED, {
        allowPrivate: true,
        redirect: "error",
      }).catch((e: unknown) => e)) as Error;

      expect(error.message).not.toContain(REDIRECT_TARGET);
      expect(error.message).not.toContain("attacker.example");
      expect(String(error.stack)).not.toContain("attacker.example");
    });

    test("`redirect: 'manual'` and `follow` are unaffected", async () => {
      fetchMock.mockResolvedValueOnce(redirectTo(REDIRECT_TARGET));
      const manual = await safeFetch(REQUESTED, { allowPrivate: true, redirect: "manual" });
      expect(manual.status).toBe(302);

      fetchMock
        .mockResolvedValueOnce(redirectTo("http://localhost:3000/hook/v2"))
        .mockResolvedValueOnce(ok());
      const followed = await safeFetch(REQUESTED, { allowPrivate: true });
      expect(followed.status).toBe(200);
    });
  });

  // The server transport reaches the network through undici and a real socket,
  // so its refusal branch is pinned at the source instead: BOTH transports must
  // route through the one factory. Two hand-rolled throws is exactly how the
  // refusals drift apart again — which the consumer would not notice, because
  // its fallback is retryable.
  describe("both transports refuse through the one factory", () => {
    const transports = ["SafeFetch.ts", "SafeFetch.server.ts"] as const;

    test.each(transports)("%s throws the sentinel for redirect mode 'error'", async (file) => {
      const source = await readFile(resolve(transportDir, file), "utf8");
      const branch = source.split(`if (requestedRedirectMode === "error") {`);

      expect(branch.length).toBe(2);
      const body = branch[1]!.split("}")[0]!;
      expect(body).toContain("throw createSafeFetchRedirectError(currentUrl, response.status);");
    });

    test.each(transports)("%s constructs no bare TypeError refusal", async (file) => {
      const source = await readFile(resolve(transportDir, file), "utf8");
      expect(source).not.toContain("new TypeError");
    });

    test.each(transports)("%s does not read Location before refusing", async (file) => {
      const source = await readFile(resolve(transportDir, file), "utf8");
      // The only `location` read must come AFTER the refusal branch, on the
      // follow path — the target of a refused redirect is never even looked at.
      const refusalAt = source.indexOf(`if (requestedRedirectMode === "error") {`);
      const locationAt = source.indexOf(`headers.get("location")`);
      expect(refusalAt).toBeGreaterThan(-1);
      expect(locationAt).toBeGreaterThan(refusalAt);
    });
  });
});
