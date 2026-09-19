/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { isLoopbackHostname } from "./localUrl";

/**
 * Shared cloud-provider client utilities: API-key resolution and browser-env
 * detection. Used by each provider's `*_Client.ts` so the same fallback chain
 * (provider_config → env var) lives in one place.
 */

export interface CloudCredentialConfig {
  readonly credential_key?: string;
  readonly api_key?: string;
}

export interface ResolveApiKeyArgs {
  readonly config: CloudCredentialConfig | undefined;
  /** Single env var name, or list of alternatives tried in order. */
  readonly envVar: string | readonly string[];
  /** Human-friendly provider label used in the error message. */
  readonly providerLabel: string;
}

/**
 * Resolve the API key for a cloud provider.
 *
 * Looks at `config.credential_key`, then `config.api_key`, then each entry in
 * `envVar` (in order). Throws a uniform error if nothing is found.
 */
export function resolveApiKey(args: ResolveApiKeyArgs): string {
  const fromConfig = args.config?.credential_key || args.config?.api_key;
  if (fromConfig) return fromConfig;

  const envVars = typeof args.envVar === "string" ? [args.envVar] : args.envVar;
  if (typeof process !== "undefined") {
    for (const name of envVars) {
      const v = process.env?.[name];
      if (v) return v;
    }
  }

  const envList = envVars.join(" / ");
  throw new Error(
    `Missing ${args.providerLabel} API key: set provider_config.credential_key or the ${envList} environment variable.`
  );
}

/**
 * True when running inside a browser-like environment (window/worker globals
 * present). Cloud SDKs use this to set their `dangerouslyAllowBrowser` flag.
 */
export function isBrowserLike(): boolean {
  return typeof globalThis.document !== "undefined" || "WorkerGlobalScope" in globalThis;
}

export interface ValidateProviderBaseUrlArgs {
  /** Discriminator used only for error messages. */
  readonly vendor: "openai" | "anthropic" | "xai" | "deepseek" | "typesafe";
  /**
   * Allow-list of acceptable hostnames or hostname suffixes. Matching is
   * label-boundary: a hostname matches if it equals the entry, or if it ends
   * with `"." + entry`. Entries may include a leading dot (e.g.
   * `".openai.azure.com"`) to make the subdomain intent explicit — the dot
   * is stripped before the boundary check, so any subdomain of
   * `openai.azure.com` matches but `notopenai.azure.com` does not.
   */
  readonly allowHosts: readonly string[];
  /**
   * When `true`, the caller has explicitly opted out of host validation
   * (e.g. an enterprise gateway with a custom domain). The URL still has
   * to parse and use a safe scheme.
   */
  readonly trustedBaseUrl?: boolean;
  /** Human-friendly provider label used in error messages. */
  readonly providerLabel: string;
}

/**
 * Validate a provider `base_url` before handing it to the SDK.
 *
 * Cloud SDKs send the API key in `Authorization: Bearer` to whatever
 * `baseURL` they are constructed with. In multi-tenant scenarios
 * (marketplace model definitions, workflow imports) an attacker can
 * exfiltrate the key by pointing `base_url` at their own server. This
 * helper enforces two defenses before construction:
 *
 *   - The URL must parse and use HTTPS (HTTP is allowed only for the
 *     loopback hostnames `localhost` / `127.0.0.1` / `[::1]`, where the
 *     request never leaves the machine and is presumed to be a local
 *     gateway such as Ollama / LM Studio / vLLM).
 *   - The hostname must match an entry in {@link ValidateProviderBaseUrlArgs.allowHosts}
 *     by exact equality or by suffix (so subdomains of e.g. `openai.azure.com`
 *     are permitted), unless the host is a loopback address (auto-allowed:
 *     the user can't exfiltrate their own key to their own machine) or
 *     the model is explicitly flagged as `trustedBaseUrl`.
 *
 * Returns the normalized string form. Returns `undefined` for an empty /
 * undefined input so the SDK falls back to its default base URL.
 *
 * @throws when the URL fails to parse, uses an unsafe scheme, or points
 *   at a non-allow-listed host without `trustedBaseUrl`.
 */
export function validateProviderBaseUrl(
  baseUrl: string | undefined,
  opts: ValidateProviderBaseUrlArgs
): string | undefined {
  if (!baseUrl) return undefined;
  const trimmed = baseUrl.trim();
  if (trimmed === "") return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${opts.providerLabel} provider base_url is not a valid URL: ${trimmed}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  // For IPv6 literals, parsed.hostname comes back bracketed (e.g. "[::1]");
  // isLoopbackHostname expects the bare form, so strip the brackets first.
  // Delegating to the shared helper means we accept the full structurally-
  // loopback grammar (::1, ::0001, ::ffff:127.x.x.x) instead of a hand-rolled
  // three-literal whitelist that misses equivalent IPv6 spellings.
  const bareHostname =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const isLoopback = isLoopbackHostname(bareHostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new Error(
      `${opts.providerLabel} provider base_url must use https:// (http:// allowed only for localhost): ${trimmed}`
    );
  }

  if (isLoopback || opts.trustedBaseUrl) {
    return parsed.toString();
  }

  const allowed = opts.allowHosts.some((host) => {
    // Strip a leading dot so allow-list entries like ".openai.azure.com"
    // continue to denote "any subdomain of openai.azure.com" while we apply
    // a strict label-boundary check against the normalized host.
    const lower = host.toLowerCase().trim().replace(/^\./, "");
    if (lower === "") return false;
    return hostname === lower || hostname.endsWith("." + lower);
  });
  if (!allowed) {
    throw new Error(
      `${opts.providerLabel} provider base_url host "${hostname}" is not in the allow-list. ` +
        `Set provider_config.trustedBaseUrl = true to opt out of host validation for a known-good custom gateway.`
    );
  }

  return parsed.toString();
}
