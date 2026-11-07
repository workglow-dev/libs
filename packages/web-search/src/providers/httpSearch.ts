/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext } from "@workglow/task-graph";
import { TaskFailedError } from "@workglow/task-graph";
import { FetchUrlTask } from "@workglow/tasks";

export interface SearchFetchOptions {
  readonly provider: string;
  readonly url: string;
  readonly method?: "GET" | "POST" | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly body?: string | undefined;
  readonly credentialKey?: string | undefined;
  /**
   * Where the resolved credential goes. Brave wants a bare API-key header,
   * Tavily an `Authorization: Bearer`, SearXNG nothing at all.
   */
  readonly credentialScheme?: "bearer" | "header" | undefined;
  readonly credentialHeader?: string | undefined;
}

/**
 * Runs one search request through an owned {@link FetchUrlTask}, so a provider
 * adapter inherits credential resolution, SafeFetch's redirect/SSRF checks,
 * retry and backoff, per-attempt timeouts, and the response cache instead of
 * reimplementing each.
 *
 * It does **not** inherit the job queue's rate limiter, and cannot: `FetchUrlTask`
 * refuses `credential_key` on the queued path, because a queued job payload is
 * persisted to durable storage and would write the resolved secret there. Every
 * keyed provider therefore runs inline. Search APIs are metered against hard
 * monthly quotas, so bounding concurrency across a fan-out is the caller's job —
 * cap the `MapTask` rather than assuming a limiter here.
 */
export async function fetchSearchJson(
  options: SearchFetchOptions,
  context: IExecuteContext
): Promise<unknown> {
  // Uncached like WebSearchTask itself: a search answers what the web says now.
  const fetchTask = context.own(
    new FetchUrlTask({ queue: false, title: `${options.provider} search` }, { cacheable: false })
  );
  const response = await fetchTask.run({
    url: options.url,
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body,
    response_type: "json",
    credential_key: options.credentialKey,
    credential_scheme: options.credentialKey ? (options.credentialScheme ?? "bearer") : undefined,
    credential_header: options.credentialHeader,
  });
  const json = response.json;
  if (json === undefined || json === null) {
    throw new TaskFailedError(
      `WebSearchTask: ${options.provider} returned no JSON body ` +
        `(status ${response.metadata?.status ?? "unknown"}).`
    );
  }
  return json;
}
