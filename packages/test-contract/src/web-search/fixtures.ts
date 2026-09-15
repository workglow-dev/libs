/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IWebSearchProvider, WebSearchRequest } from "@workglow/web-search";
import { WebSearchProviderRegistry } from "@workglow/web-search";
import type { WebSearchConformanceHarness } from "./types";

/** The query every assertion searches for, so a rewrite of it is visible. */
export const PROBE_QUERY = "transformer architecture";

/**
 * A provider registered beside the one under test, so `"auto"` has somewhere
 * else to land and a credential can be named for a vendor that is not this one.
 *
 * It declares everything, which is what makes it a useful foil: routing prefers
 * a provider a key is named for, so a decoy that could serve the request is the
 * only way to catch a key reaching the wrong vendor.
 */
export function decoyProvider(
  name: string,
  onSearch?: (r: WebSearchRequest) => void
): IWebSearchProvider {
  return {
    name,
    endpoint: `https://${name}.invalid`,
    acceptsCredentialKey: true,
    capabilities: {
      answer: true,
      content: true,
      domainFilter: "native",
      dateFilter: true,
      maxResultsCap: undefined,
    },
    search: async (request) => {
      onSearch?.(request);
      return {
        results: [{ title: "decoy", url: `https://${name}.invalid/a` }],
        query: request.query,
      };
    },
  };
}

/** Registers the provider under test alone, the state most assertions want. */
export function registerOnly(harness: WebSearchConformanceHarness): void {
  WebSearchProviderRegistry.clear();
  WebSearchProviderRegistry.register(harness.provider);
}

/**
 * Whether a domain restriction reaches this provider as a list or as `site:`
 * operators spliced into the query. The exclude direction defaults to the
 * include direction, exactly as the task reads it.
 */
export function domainRoutes(provider: IWebSearchProvider): {
  readonly include: "native" | "query-operator" | false;
  readonly exclude: "native" | "query-operator" | false;
} {
  const capabilities = provider.capabilities;
  return {
    include: capabilities.domainFilter,
    exclude: capabilities.excludeDomainFilter ?? capabilities.domainFilter,
  };
}

/**
 * Percent-decoded, with `+` read as a space, or the input unchanged when it
 * carries a sequence that is not valid encoding.
 */
function decodeLoosely(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

/**
 * Everything one search sent, as a single string to look for a substring in.
 *
 * The decoded rendering is appended rather than substituted, so a value matches
 * whichever way this provider carried it. One sends `site:example.com` in a
 * JSON body and the next sends `site%3Aexample.com` in a query string; both are
 * the same restriction, and a suite that reads only the raw bytes would report
 * the second as a restriction that never left. Appending keeps the equality
 * assertions exact — two sends are equal here only if their raw forms were.
 */
export function sentText(harness: WebSearchConformanceHarness): string {
  const raw = harness.sent().join("\n");
  return `${raw}\n${decodeLoosely(raw)}`;
}
