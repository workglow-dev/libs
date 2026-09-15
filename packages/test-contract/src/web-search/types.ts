/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IWebSearchProvider, WebSearchRequest, WebSearchResponse } from "@workglow/web-search";

/**
 * One provider, wired to a transport that answers it instead of a vendor.
 *
 * The transport is the adapter's own boundary, not a network stub: an HTTP
 * provider is intercepted at the `FetchUrlTask` it owns, an SDK-backed one at
 * the client handed to its constructor. Both report what went out as text,
 * which is what lets one suite assert "the option reached the wire" across two
 * transports that share no shape.
 */
export interface WebSearchConformanceHarness {
  readonly provider: IWebSearchProvider;
  /**
   * Everything the adapter sent outward, one entry per call, flattened to text
   * — a URL with its query string and body, or the JSON of the SDK arguments.
   *
   * Flattened rather than structured because every assertion over it is
   * differential: the same search with and without one option has to send
   * something different. That question has an answer for every provider, where
   * "which field carries the date bound" has a different one for each.
   */
  readonly sent: () => readonly string[];
  /** The abort signal each outbound call was given, in call order. */
  readonly signals: () => ReadonlyArray<AbortSignal | undefined>;
  /** Runs the provider directly against this transport, under `signal`. */
  readonly search: (request: WebSearchRequest, signal: AbortSignal) => Promise<WebSearchResponse>;
  /** Removes the interception. Called after every test. */
  readonly dispose: () => void;
}

export interface WebSearchHarnessRequest {
  /** How many results the canned answer carries. */
  readonly resultCount: number;
}

export interface WebSearchProviderConformanceOpts {
  readonly name: string;
  readonly skip?: boolean;
  readonly timeout?: number;
  /**
   * A fresh provider and transport per test. Nothing is shared between tests: a
   * registry is process-wide, and a provider that cached a client in one test
   * would answer the next one's assertions about what it sent.
   */
  readonly createHarness: (
    request: WebSearchHarnessRequest
  ) => Promise<WebSearchConformanceHarness>;
  /**
   * Whether the run's `AbortSignal` is handed to the outbound call itself.
   *
   * True for an adapter reaching a vendor SDK, where nothing else would stop a
   * grounded turn that is still being billed. False for one whose fetch this
   * package owns: cancellation reaches it through the `FetchUrlTask` it owns
   * and that task's own scope, so the adapter passes no signal of its own and
   * there is nothing at this boundary to observe. A flag rather than a silent
   * skip, because "this adapter drops the signal" and "this adapter never held
   * one" are the two answers that must not look alike.
   */
  readonly signalReachesTransport: boolean;
  /**
   * A domain this provider's canned results sit on, used where a request has to
   * name a real-looking host. Defaults to `example.com`.
   */
  readonly sampleDomain?: string;
}
