/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext } from "@workglow/task-graph";

/**
 * A single web result. Heterogeneous by provider — only title and url are guaranteed.
 *
 * A type alias rather than an interface because this crosses a task port: TypeScript
 * gives an alias an implicit index signature and an interface none, so the interface
 * form is not assignable to the `DataPorts` constraint `Task` imposes on its output.
 */
export type SearchResult = {
  readonly title: string;
  readonly url: string;
  readonly snippet?: string | undefined;
  /** Full page text, when the provider returns it and the caller asked. */
  readonly content?: string | undefined;
  /** ISO-8601 when the provider reports one. */
  readonly publishedDate?: string | undefined;
  readonly score?: number | undefined;
  readonly favicon?: string | undefined;
};

export interface WebSearchDateRange {
  readonly start?: string | undefined;
  readonly end?: string | undefined;
}

export interface WebSearchRequest {
  readonly query: string;
  readonly maxResults?: number | undefined;
  readonly includeDomains?: readonly string[] | undefined;
  readonly excludeDomains?: readonly string[] | undefined;
  readonly dateRange?: WebSearchDateRange | undefined;
  readonly includeAnswer?: boolean | undefined;
  readonly includeContent?: boolean | undefined;
  /** Credential-store key, resolved by the owned FetchUrlTask. Unused by SDK adapters. */
  readonly credentialKey?: string | undefined;
}

/** Type alias for the same port-assignability reason as {@link SearchResult}. */
export type WebSearchUsage = {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  /** Metered APIs bill per request, not per token. */
  readonly requests?: number | undefined;
};

export interface WebSearchResponse {
  readonly results: readonly SearchResult[];
  readonly answer?: string | undefined;
  /** The query actually sent — the site: translation rewrites it. */
  readonly query: string;
  readonly usage?: WebSearchUsage | undefined;
}

/**
 * How a provider restricts results to a domain set.
 *
 * - `"native"` — the API takes a domain list directly.
 * - `"query-operator"` — the engine understands `site:`, so the restriction is
 *   expressed by rewriting the query. A faithful translation on a Google-shaped
 *   engine, not an approximation.
 * - `false` — cannot restrict at all; routing excludes it and a pinned request throws.
 */
export type DomainFilterSupport = "native" | "query-operator" | false;

export interface WebSearchCapabilities {
  readonly answer: boolean;
  readonly content: boolean;
  readonly domainFilter: DomainFilterSupport;
  /**
   * How the provider restricts results AWAY from a domain set, when that differs
   * from {@link domainFilter}. Defaults to `domainFilter` — most providers treat
   * the two symmetrically.
   *
   * It exists because one real provider does not: OpenAI's `web_search` tool
   * takes `filters.allowed_domains` and has no blocked-domain equivalent. Folded
   * into a single field, that provider would either have to under-declare (losing
   * working include filtering) or over-declare — and over-declaring is the
   * failure this whole record exists to prevent, because `"auto"` routing would
   * hand it an `excludeDomains` request it silently cannot honor.
   */
  readonly excludeDomainFilter?: DomainFilterSupport | undefined;
  /**
   * `true` when the provider filters in either direction but never both in the
   * same request — Anthropic's `web_search` tool takes `allowed_domains` or
   * `blocked_domains` and rejects the pair.
   *
   * Without it such a provider over-declares exactly the way
   * {@link excludeDomainFilter} exists to prevent: both directions look
   * supported, `unhonorableOptions` finds no gap, `"auto"` routes to it, and
   * `search()` throws on a request the provider registered right behind it
   * would have served natively.
   */
  readonly exclusiveDomainDirections?: boolean | undefined;
  /**
   * Date filtering is never emulated. Post-filtering by `publishedDate` breaks
   * `maxResults` and drops every result whose date the provider omitted, so a
   * provider that cannot do it server-side declares `false` and the request is
   * refused rather than approximated.
   */
  readonly dateFilter: boolean;
  readonly maxResultsCap: number | undefined;
}

/**
 * A web-search backend, HTTP or model-grounded, behind one normalized shape.
 *
 * **An implementer runs `runWebSearchProviderConformance`**
 * (`@workglow/test-contract/web-search`), which reads {@link capabilities} and
 * asserts the matching behaviour: an option declared unservable is refused
 * before the vendor is reached, and one declared servable actually reaches the
 * wire. Over-declaring is the failure the whole record exists to prevent, and
 * it does not throw — the adapter drops the option and reports a search that
 * looks like it honored it.
 */
export interface IWebSearchProvider {
  readonly name: string;
  readonly capabilities: WebSearchCapabilities;
  /**
   * Origin this provider reaches over HTTP, for resource-scoped entitlements.
   * `undefined` for an adapter that goes through a vendor SDK rather than a
   * URL this package controls.
   */
  readonly endpoint: string | undefined;
  /**
   * Whether {@link WebSearchRequest.credentialKey} reaches this provider's
   * request. True for one whose fetch this package owns, where the owned
   * `FetchUrlTask` resolves the key and attaches it. False for an adapter that
   * authenticates through a vendor client, and for an unauthenticated instance
   * — both ignore the field, so naming a key for one is refused rather than
   * dropped in silence.
   */
  readonly acceptsCredentialKey: boolean;
  search(request: WebSearchRequest, context: IExecuteContext): Promise<WebSearchResponse>;
}
