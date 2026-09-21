/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  abortableFetch,
  assertFileFitsInMemory,
  getHftMaxModelFileBytes,
  HftModelFileTooLargeError,
  setHftMaxModelFileBytes,
} from "@workglow/huggingface-transformers/ai-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODEL_URL = "https://huggingface.co/Test/big-model/resolve/main/onnx/model_q4f16.onnx_data";

function responseOf(contentLength: string | undefined, init?: ResponseInit): Response {
  const headers = new Headers(
    contentLength === undefined ? {} : { "content-length": contentLength }
  );
  const response = new Response(new ReadableStream<Uint8Array>({ start: (c) => c.close() }), {
    status: 200,
    ...init,
    headers,
  });
  // `Response.url` is read-only and empty for a hand-built response; the error
  // message names the file, so give it one.
  Object.defineProperty(response, "url", { value: MODEL_URL });
  return response;
}

describe("HFT model-file size guard", () => {
  beforeEach(() => {
    setHftMaxModelFileBytes(1000);
  });

  afterEach(() => {
    // A non-positive value clears the override, so the next test reads this
    // runtime's own default rather than whatever the last one pinned.
    setHftMaxModelFileBytes(0);
    vi.unstubAllGlobals();
  });

  it("rejects a file larger than the runtime's single-allocation ceiling", () => {
    expect(() => assertFileFitsInMemory(responseOf("1001"))).toThrow(HftModelFileTooLargeError);
  });

  it("names the file and both sizes so the failure is actionable", () => {
    let caught: unknown;
    try {
      assertFileFitsInMemory(responseOf("2146754560"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HftModelFileTooLargeError);
    const err = caught as HftModelFileTooLargeError;
    expect(err.name).toBe("ModelFileTooLargeError");
    expect(err.size).toBe(2146754560);
    expect(err.limit).toBe(1000);
    expect(err.message).toContain("model_q4f16.onnx_data");
    expect(err.message).toContain("2.15 GB");
  });

  it("allows a file at exactly the ceiling", () => {
    expect(() => assertFileFitsInMemory(responseOf("1000"))).not.toThrow();
  });

  it("allows a response with no content-length", () => {
    // transformers.js grows its buffer as it reads when the header is absent,
    // so there is no up-front allocation to guard against.
    expect(() => assertFileFitsInMemory(responseOf(undefined))).not.toThrow();
  });

  it("ignores a non-ok response", () => {
    expect(() => assertFileFitsInMemory(responseOf("1001", { status: 404 }))).not.toThrow();
  });

  it("is disabled by an infinite limit", () => {
    setHftMaxModelFileBytes(Number.POSITIVE_INFINITY);
    expect(() => assertFileFitsInMemory(responseOf("999999999999"))).not.toThrow();
  });

  // Both call sites throw out of a `.then`, so nothing downstream releases the
  // body the guard refused to let through.
  it("cancels the rejected response body rather than leaving it unread", () => {
    const response = responseOf("1001");
    expect(() => assertFileFitsInMemory(response)).toThrow(HftModelFileTooLargeError);
    expect(response.bodyUsed || response.body === null || response.body.locked).toBe(true);
  });

  it("fails the fetch before transformers.js can allocate the buffer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseOf("1001"))
    );
    await expect(abortableFetch(MODEL_URL)).rejects.toThrow(HftModelFileTooLargeError);
  });
});

/**
 * The ceiling is a property of the JS engine, not of whether `process` is
 * reachable: an Electron renderer with node integration answers
 * `process.versions.node` and is Chromium — the renderer the 2 GiB limit was
 * measured on, OOM-kill included.
 */
describe("HFT model-file default ceiling", () => {
  const CHROMIUM_CEILING = 2 * 1024 * 1024 * 1024 - 4 * 1024 * 1024;

  afterEach(() => {
    setHftMaxModelFileBytes(0);
    vi.unstubAllGlobals();
  });

  it("decides the default by the engine, not by `process.versions.node`", () => {
    setHftMaxModelFileBytes(0);
    // This process has `process.versions.node`, and so does an Electron
    // renderer. What separates them is the engine, which is what decides the
    // allocation ceiling.
    expect(process.versions.node).toBeDefined();
    expect(getHftMaxModelFileBytes()).toBe(Number.POSITIVE_INFINITY);

    vi.stubGlobal("document", {});
    expect(getHftMaxModelFileBytes()).toBe(CHROMIUM_CEILING);
  });

  it("caps a worker runtime", () => {
    setHftMaxModelFileBytes(0);
    vi.stubGlobal("WorkerGlobalScope", class {});

    expect(getHftMaxModelFileBytes()).toBe(CHROMIUM_CEILING);
  });

  it("keeps an explicit override ahead of the runtime default", () => {
    vi.stubGlobal("document", {});
    setHftMaxModelFileBytes(Number.POSITIVE_INFINITY);

    expect(getHftMaxModelFileBytes()).toBe(Number.POSITIVE_INFINITY);
  });
});
