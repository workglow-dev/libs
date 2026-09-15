/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IExecuteContext } from "@workglow/task-graph";
import { FetchUrlTask } from "@workglow/tasks";
import type { WebSearchConformanceHarness } from "@workglow/test-contract/web-search";
import type { IWebSearchProvider, WebSearchRequest } from "@workglow/web-search";

/**
 * A context an adapter can run one search against, outside a graph.
 *
 * Only the three members a provider actually reaches for. `own` hands back the
 * task unchanged — the interception is on `FetchUrlTask.prototype`, so the real
 * task is constructed and its `run` is what answers.
 */
export function harnessContext(signal: AbortSignal): IExecuteContext {
  return {
    signal,
    updateProgress: async () => {},
    own: <T>(resource: T): T => resource,
  } as unknown as IExecuteContext;
}

interface HttpHarnessOptions {
  readonly provider: IWebSearchProvider;
  /** The vendor's JSON for a search returning `resultCount` results. */
  readonly payload: unknown;
}

/**
 * Intercepts the `FetchUrlTask` an HTTP adapter owns.
 *
 * On the prototype rather than on the context, because the adapter constructs
 * its own task and a context that handed back a stub would also be testing a
 * `FetchUrlTask` the adapter never built — losing the credential port, the
 * method and the body, which is most of what these assertions read.
 */
export function httpHarness(options: HttpHarnessOptions): WebSearchConformanceHarness {
  const sent: string[] = [];
  const original = FetchUrlTask.prototype.run;

  (FetchUrlTask.prototype as { run: unknown }).run = async function patched(
    input: Record<string, unknown>
  ) {
    sent.push(JSON.stringify(input));
    return { json: options.payload, metadata: { status: 200 } };
  };

  return {
    provider: options.provider,
    sent: () => sent,
    // An owned `FetchUrlTask` inherits cancellation through the run's scope
    // rather than through a signal this adapter passes, so there is none here
    // to report. The suite's signal block is flagged off for this reason.
    signals: () => [],
    search: (request: WebSearchRequest, signal: AbortSignal) =>
      options.provider.search(request, harnessContext(signal)),
    dispose: () => {
      (FetchUrlTask.prototype as { run: unknown }).run = original;
    },
  };
}

interface SdkHarnessOptions {
  readonly provider: IWebSearchProvider;
  /** Outbound call arguments, appended by the fake client as it is called. */
  readonly sent: string[];
  /** The signal each outbound call received. */
  readonly signals: Array<AbortSignal | undefined>;
}

/** Wraps a provider whose fake vendor client is already recording into it. */
export function sdkHarness(options: SdkHarnessOptions): WebSearchConformanceHarness {
  return {
    provider: options.provider,
    sent: () => options.sent,
    signals: () => options.signals,
    search: (request: WebSearchRequest, signal: AbortSignal) =>
      options.provider.search(request, harnessContext(signal)),
    dispose: () => {},
  };
}

/** `n` distinct result URLs, so a `maxResults` bound has something to cut. */
export function sampleUrls(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `https://example.com/result-${i}`);
}
