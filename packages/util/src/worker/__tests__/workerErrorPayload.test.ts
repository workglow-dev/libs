/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { rehydrateWorkerError, workerErrorPayload } from "../scrubStack";

/** What the worker posts, as the main thread receives it. */
const roundTrip = (error: unknown, includeStack = false): Error =>
  rehydrateWorkerError(
    JSON.parse(JSON.stringify(workerErrorPayload(error, { includeStack, roots: [] })))
  );

describe("workerErrorPayload → rehydrateWorkerError", () => {
  it("carries the message and the name", () => {
    const err = Object.assign(new Error("model unavailable"), { name: "ProviderError" });
    const back = roundTrip(err);
    expect(back.message).toBe("model unavailable");
    expect(back.name).toBe("ProviderError");
  });

  it("carries a declared `retryable` across the boundary", () => {
    // The class does not survive the trip, so without the flag the main thread
    // receives an anonymous Error and has to assume the failure is permanent —
    // which turns every worker-side rate limit into a terminal failure.
    const err = Object.assign(new Error("rate limited"), { retryable: true });
    expect((roundTrip(err) as { retryable?: unknown }).retryable).toBe(true);
  });

  it("carries a declared `retryable: false` as the claim it is", () => {
    const err = Object.assign(new Error("content policy"), { retryable: false });
    expect((roundTrip(err) as { retryable?: unknown }).retryable).toBe(false);
  });

  it("leaves the flag absent when the error never declared one", () => {
    // Absent and false are different: a consumer reading the field has to be
    // able to tell "nothing was said" from "no", or every worker that predates
    // the flag looks like it answered.
    expect("retryable" in roundTrip(new Error("boom"))).toBe(false);
  });

  it("omits the stack unless the caller asked for it", () => {
    const err = new Error("boom");
    expect(workerErrorPayload(err, { includeStack: false, roots: [] }).stack).toBeUndefined();
    expect(workerErrorPayload(err, { includeStack: true, roots: [] }).stack).toBeDefined();
  });

  it("scrubs the roots out of a stack it does carry", () => {
    const err = Object.assign(new Error("boom"), { stack: "at /home/build/app/x.ts:1:1" });
    const payload = workerErrorPayload(err, { includeStack: true, roots: ["/home/build"] });
    expect(payload.stack).toBe("at <root>/app/x.ts:1:1");
  });

  it("flattens a non-Error throw without inventing a classification", () => {
    expect(workerErrorPayload("just a string", { includeStack: true, roots: [] })).toEqual({
      message: "just a string",
      name: "Error",
    });
    expect(workerErrorPayload(42, { includeStack: true, roots: [] })).toEqual({
      message: "42",
      name: "Error",
    });
  });
});
