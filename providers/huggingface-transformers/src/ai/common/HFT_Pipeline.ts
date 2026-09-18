/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DynamicCache, PretrainedModelOptions, ProgressInfo } from "@huggingface/transformers";
import type { StreamPhase } from "@workglow/task-graph";
import { getLogger } from "@workglow/util/worker";
import { resolveHftPipelineDevice } from "./HFT_Device";
import type { HfTransformersOnnxModelConfig } from "./HFT_ModelSchema";

type TransformersSDKModule = typeof import("@huggingface/transformers");

let _transformersSdk: TransformersSDKModule | undefined;
let _cacheDir: string | undefined;
let _loadPromise: Promise<TransformersSDKModule> | undefined;

/**
 * Set the filesystem cache directory for downloaded transformers.js models.
 * Must be called before any model is loaded.
 */
export function setHftCacheDir(dir: string): void {
  _cacheDir = dir;
  if (_transformersSdk) {
    _transformersSdk.env.cacheDir = dir;
  }
}

// NOTE: we do not want to de-dup this in the provider-utils, vite wants direct import with string literals.
export async function loadTransformersSDK(): Promise<TransformersSDKModule> {
  _loadPromise ??= import("@huggingface/transformers")
    .then((mod) => {
      mod.env.fetch = abortableFetch as typeof fetch;
      if (_cacheDir) {
        mod.env.cacheDir = _cacheDir;
      }
      _transformersSdk = mod;
      return mod;
    })
    .catch((err: unknown) => {
      _loadPromise = undefined;
      // Preserve the underlying failure — a missing package is only one cause.
      // Linked `bun link` setups often fail here on a sharp/libvips mismatch
      // (e.g. format.jp2k) which this wrapper used to hide.
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `@huggingface/transformers failed to load (${detail}). ` +
          `Install it in the app package (bun add @huggingface/transformers). ` +
          `If it is already installed, check for conflicting sharp / @img/sharp-* versions after bun link.`
      );
    });
  return _loadPromise;
}

/**
 * Per-model AbortControllers used by abortableFetch; keyed by model_path.
 *
 * A Set is used (not a single controller) because two concurrent
 * `getPipeline` calls for the same `model_path` but different pipeline /
 * dtype / device combinations produce different cache keys — the load
 * dedupe in {@link pipelineLoadPromises} misses, so both loads race and
 * each registers its own controller. Overwriting orphans the first
 * caller's controller.
 *
 * @internal Exported for unit tests.
 */
export const modelAbortControllers = new Map<string, Set<AbortController>>();

/**
 * Segment-based match between a URL pathname and a HuggingFace `model_path`.
 * Prevents substring collisions such as
 * `Xenova/bge-reranker-base` matching `Xenova/bge-reranker-base-v2`.
 *
 * @internal Exported for unit tests.
 */
export function pathMatchesModelSegment(pathname: string, modelPath: string): boolean {
  const modelSegments = modelPath.split("/").filter(Boolean);
  if (modelSegments.length === 0) return false;
  const pathSegments = pathname.split("/").filter(Boolean);
  outer: for (let i = 0; i + modelSegments.length <= pathSegments.length; i++) {
    for (let j = 0; j < modelSegments.length; j++) {
      if (pathSegments[i + j] !== modelSegments[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Remove `controller` from the set registered under `modelPath`, and delete
 * the map entry entirely when its set becomes empty so `abortableFetch`
 * doesn't linearly walk stale keys forever.
 */
function removeModelController(modelPath: string, controller: AbortController): void {
  const active = modelAbortControllers.get(modelPath);
  if (!active) return;
  active.delete(controller);
  if (active.size === 0) modelAbortControllers.delete(modelPath);
}

function combineAbortSignals(
  existingSignal: AbortSignal | null | undefined,
  modelSignal: AbortSignal | undefined
): AbortSignal | undefined {
  if (!existingSignal) {
    return modelSignal;
  }
  if (!modelSignal) {
    return existingSignal;
  }
  if (existingSignal.aborted || modelSignal.aborted) {
    return AbortSignal.abort(existingSignal.reason ?? modelSignal.reason);
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([existingSignal, modelSignal]);
  }

  const controller = new AbortController();
  const abort = (event: Event) => {
    const signal = event.target as AbortSignal;
    controller.abort(signal.reason);
  };
  existingSignal.addEventListener("abort", abort, { once: true });
  modelSignal.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function createAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(String(reason ?? "Fetch aborted"));
}

// ============================================================================
// Stall watchdog for model-file fetches
// ============================================================================

/**
 * Thrown when a model-file fetch delivers no bytes for
 * {@link getHftFetchStallTimeoutMs} milliseconds — either no response headers
 * at all, or a body stream that has gone silent mid-transfer.
 *
 * A dropped connection in the browser frequently does *not* reject the fetch:
 * the pending `reader.read()` simply never settles, so without this watchdog a
 * download freezes with no error, no progress, and no way for the UI to tell a
 * stall apart from a slow link. The name deliberately avoids `AbortError` and
 * the message avoids the "aborted" patterns that {@link classifyProviderError}
 * maps to a user cancellation — a stall is a failure, not a cancel.
 */
export class HftDownloadStalledError extends Error {
  public override readonly name = "DownloadStalledError";
  constructor(
    public readonly url: string,
    public readonly stallMs: number,
    public readonly bytesReceived: number
  ) {
    super(
      `Download stalled: no data received for ${Math.round(stallMs / 1000)}s ` +
        `(${bytesReceived} bytes received) while fetching ${url}`
    );
  }
}

const DEFAULT_FETCH_STALL_TIMEOUT_MS = 60_000;

let _fetchStallTimeoutMs: number = (() => {
  if (typeof process === "undefined" || !process.env) return DEFAULT_FETCH_STALL_TIMEOUT_MS;
  const raw = process.env.HFT_FETCH_STALL_TIMEOUT_MS;
  if (!raw) return DEFAULT_FETCH_STALL_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_FETCH_STALL_TIMEOUT_MS;
})();

/**
 * Override the fetch stall timeout. `0` disables the watchdog. Defaults to
 * 60s, or `HFT_FETCH_STALL_TIMEOUT_MS` where `process.env` exists.
 */
export function setHftFetchStallTimeoutMs(ms: number): void {
  _fetchStallTimeoutMs = Math.max(0, ms);
}

export function getHftFetchStallTimeoutMs(): number {
  return _fetchStallTimeoutMs;
}

/**
 * Thrown when a model file is bigger than the largest single `ArrayBuffer` the
 * runtime will hand out.
 *
 * transformers.js `readResponse` does `new Uint8Array(content-length)` before
 * it reads a single byte, so a file over that ceiling can never be loaded —
 * not from the network and not from an already-warm Cache Storage entry.
 * Chrome refuses a single allocation a little under 2 GiB (measured: 1.998
 * GiB), and it does not always fail politely: with other weight shards already
 * resident the renderer is OOM-killed instead of throwing, which leaves the
 * download sitting at a fixed percentage forever with no error to report.
 *
 * Checking `content-length` up front turns that into an ordinary failed task.
 * The error is unretryable by nature — the same file will be the same size on
 * the next attempt — so callers should treat it as a configuration problem
 * rather than offering a retry.
 */
export class HftModelFileTooLargeError extends Error {
  public override readonly name = "ModelFileTooLargeError";
  constructor(
    public readonly url: string,
    public readonly size: number,
    public readonly limit: number
  ) {
    const gb = (n: number): string => `${(n / 1e9).toFixed(2)} GB`;
    super(
      `Model file too large for this runtime: ${url.split("/").pop()} is ${gb(size)}, ` +
        `above the ${gb(limit)} single-allocation ceiling. This model cannot be loaded here; ` +
        `choose one whose weights are split into smaller files.`
    );
  }
}

/**
 * 2 GiB less a 4 MiB margin. V8 refuses a single `ArrayBuffer` at roughly 2
 * GiB, and the exact cutoff moves with what the heap is already holding, so
 * the margin keeps the check on the right side of it. Node and Electron's main
 * process have a far higher ceiling, so they are not capped by default.
 */
const DEFAULT_MAX_MODEL_FILE_BYTES = 2 * 1024 * 1024 * 1024 - 4 * 1024 * 1024;

function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && process.versions != null && process.versions.node != null;
}

let _maxModelFileBytes: number = isNodeRuntime()
  ? Number.POSITIVE_INFINITY
  : DEFAULT_MAX_MODEL_FILE_BYTES;

/**
 * Override the largest model file this runtime will accept.
 * `Infinity` disables the check.
 */
export function setHftMaxModelFileBytes(bytes: number): void {
  _maxModelFileBytes = bytes > 0 ? bytes : DEFAULT_MAX_MODEL_FILE_BYTES;
}

export function getHftMaxModelFileBytes(): number {
  return _maxModelFileBytes;
}

/**
 * Throw {@link HftModelFileTooLargeError} when `response` declares a body this
 * runtime cannot buffer. A response with no usable `content-length` is let
 * through: transformers.js grows its buffer as it reads in that case, so there
 * is no up-front allocation to guard.
 *
 * @internal Exported for unit tests.
 */
export function assertFileFitsInMemory(response: Response): void {
  if (!response.ok) return;
  const limit = _maxModelFileBytes;
  if (!Number.isFinite(limit)) return;
  const header = response.headers.get("content-length");
  if (!header || !/^\d+$/.test(header)) return;
  const size = Number.parseInt(header, 10);
  if (size > limit) {
    throw new HftModelFileTooLargeError(response.url || "model file", size, limit);
  }
}

/**
 * Wrap `response.body` so that every read is bounded by the stall timeout and
 * the whole transfer is cancelled by `signal`.
 *
 * `stall` is the controller {@link abortableFetch} folded into `signal`; firing
 * it with a {@link HftDownloadStalledError} tears down the underlying fetch and
 * errors the wrapped stream with that same error, so the consumer
 * (transformers.js `readResponse`) rejects with a stall, not a generic abort.
 *
 * @internal Exported for unit tests.
 */
export function wrapAbortableResponse(
  response: Response,
  signal: AbortSignal | undefined,
  stall?: { controller: AbortController; url: string }
): Response {
  if (!signal || !response.body) {
    return response;
  }

  const contentLengthHeader = response.headers.get("content-length");
  const expectedSize =
    contentLengthHeader && /^\d+$/.test(contentLengthHeader)
      ? Number.parseInt(contentLengthHeader, 10)
      : undefined;
  const sourceBody = response.body;

  // Use pull-based reading to maintain backpressure: a start()-based eager
  // drain would buffer the entire response body in memory, which is fatal for
  // large model files (hundreds of MB to several GB).
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  type SourceReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
  let abortHandler: (() => void) | undefined;
  let loaded = 0;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let stallError: HftDownloadStalledError | undefined;
  const stallMs = stall ? _fetchStallTimeoutMs : 0;

  const clearStallTimer = () => {
    if (stallTimer !== undefined) {
      clearTimeout(stallTimer);
      stallTimer = undefined;
    }
  };

  const cleanup = () => {
    clearStallTimer();
    if (abortHandler) {
      signal.removeEventListener("abort", abortHandler);
      abortHandler = undefined;
    }
    reader?.releaseLock();
  };

  /**
   * Bound a single `reader.read()` by the stall timeout. On expiry, fire the
   * stall controller so the browser tears down the socket, cancel the source
   * reader so the pending read settles, and reject with the stall error.
   */
  const readWithStallWatchdog = (): Promise<SourceReadResult> => {
    if (stallMs <= 0 || !stall) return reader.read();
    return new Promise<SourceReadResult>((resolve, reject) => {
      stallTimer = setTimeout(() => {
        stallTimer = undefined;
        stallError = new HftDownloadStalledError(stall.url, stallMs, loaded);
        stall.controller.abort(stallError);
        reader.cancel(stallError).catch(() => {
          /* the source may already be errored */
        });
        reject(stallError);
      }, stallMs);
      reader.read().then(
        (result) => {
          clearStallTimer();
          resolve(result);
        },
        (error) => {
          clearStallTimer();
          reject(stallError ?? error);
        }
      );
    });
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      reader = sourceBody.getReader();
      if (signal.aborted) {
        controller.error(createAbortError(signal));
        return;
      }
      abortHandler = () => controller.error(createAbortError(signal));
      signal.addEventListener("abort", abortHandler, { once: true });
    },
    async pull(controller) {
      try {
        if (stallError) {
          throw stallError;
        }
        if (signal.aborted) {
          throw createAbortError(signal);
        }

        const { done, value } = await readWithStallWatchdog();
        if (done) {
          if (signal.aborted) {
            throw createAbortError(signal);
          }
          if (expectedSize !== undefined && loaded < expectedSize) {
            throw new Error(
              `Fetch ended before reading the full response body (${loaded}/${expectedSize} bytes)`
            );
          }
          cleanup();
          controller.close();
          return;
        }

        loaded += value.length;
        controller.enqueue(value);
      } catch (error) {
        cleanup();
        controller.error(error);
      }
    },
    cancel(reason) {
      cleanup();
      return sourceBody.cancel(reason);
    },
  });

  return new Response(body, {
    headers: new Headers(response.headers),
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * The `env.fetch` installed into transformers.js. Folds three signals into
 * the request: the caller's own `options.signal`, every live per-model
 * controller registered for the URL's `model_path`, and a stall watchdog that
 * fires when no headers arrive (here) or no body bytes arrive
 * ({@link wrapAbortableResponse}) within {@link getHftFetchStallTimeoutMs}.
 *
 * Already-aborted controllers are intentionally still honoured: a cancelled
 * load that is between files when its signal fires must have its *next*
 * fetch die immediately rather than pull a multi-GB weight file to completion.
 *
 * @internal Exported for unit tests.
 */
export function abortableFetch(url: string, options?: RequestInit): Promise<Response> {
  let modelSignal: AbortSignal | undefined;
  try {
    const pathname = new URL(url).pathname;
    const matchedSignals: AbortSignal[] = [];
    for (const [modelPath, controllers] of modelAbortControllers) {
      if (!pathMatchesModelSegment(pathname, modelPath)) continue;
      for (const controller of controllers) matchedSignals.push(controller.signal);
    }
    modelSignal =
      matchedSignals.length === 0
        ? undefined
        : matchedSignals.length === 1
          ? matchedSignals[0]
          : typeof AbortSignal.any === "function"
            ? AbortSignal.any(matchedSignals)
            : matchedSignals[0];
  } catch {
    /* not a parseable URL, proceed without abort */
  }

  const stallMs = _fetchStallTimeoutMs;
  const stallController = new AbortController();
  const stall = stallMs > 0 ? { controller: stallController, url } : undefined;

  let combinedSignal = options?.signal
    ? combineAbortSignals(options.signal, modelSignal)
    : modelSignal;
  if (stall) {
    combinedSignal = combineAbortSignals(combinedSignal, stallController.signal);
  }

  const request = fetch(url, {
    ...options,
    ...(combinedSignal ? { signal: combinedSignal } : {}),
  });

  if (!stall) {
    return request.then((response) => {
      assertFileFitsInMemory(response);
      return wrapAbortableResponse(response, combinedSignal);
    });
  }

  // Headers-phase watchdog: a fetch whose connection dies before the response
  // arrives can hang just as silently as a dead body stream.
  let headersTimer: ReturnType<typeof setTimeout> | undefined;
  const headersStall = new Promise<never>((_, reject) => {
    headersTimer = setTimeout(() => {
      headersTimer = undefined;
      const error = new HftDownloadStalledError(url, stallMs, 0);
      stallController.abort(error);
      reject(error);
    }, stallMs);
  });
  const clearHeadersTimer = () => {
    if (headersTimer !== undefined) {
      clearTimeout(headersTimer);
      headersTimer = undefined;
    }
  };

  return Promise.race([request, headersStall]).then(
    (response) => {
      clearHeadersTimer();
      // Before transformers.js sees it: a body this runtime cannot allocate
      // must fail here, while there is still a stack to fail on.
      assertFileFitsInMemory(response);
      return wrapAbortableResponse(response, combinedSignal, stall);
    },
    (error: unknown) => {
      clearHeadersTimer();
      // If the watchdog fired, surface the stall rather than the fetch's own
      // AbortError so the failure classifies as a network fault, not a cancel.
      const reason = stallController.signal.reason;
      throw reason instanceof HftDownloadStalledError ? reason : error;
    }
  );
}

/** @internal Cached pipelines keyed by {@link getPipelineCacheKey}. Exported for unit tests. */
export const pipelines = new Map<string, Awaited<ReturnType<TransformersSDKModule["pipeline"]>>>();

/**
 * Upper bound on cached pipelines. Each pipeline pins an ONNX session (WASM
 * heap / WebGPU buffers) that is never reclaimed by V8 GC — only an explicit
 * `session.release()` frees it. Without a cap, a caller cycling through
 * embed + classify + generate + rerank keeps every pipeline for the process
 * lifetime, and browser/WASM contexts have no OOM retry path.
 *
 * Overridable via `HFT_MAX_CACHED_PIPELINES`. Guarded for browser contexts
 * where `process` is undefined.
 */
export const MAX_CACHED_PIPELINES: number = (() => {
  if (typeof process === "undefined" || !process.env) return 6;
  const raw = process.env.HFT_MAX_CACHED_PIPELINES;
  if (!raw) return 6;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 6;
})();

/**
 * Move `cacheKey` to the most-recently-used end of the `pipelines` iteration
 * order. Map iteration follows insertion order, so delete-then-set is the
 * canonical LRU-touch pattern. No-op if the key isn't cached.
 */
function touchPipeline(cacheKey: string): void {
  const pipeline = pipelines.get(cacheKey);
  if (pipeline === undefined) return;
  pipelines.delete(cacheKey);
  pipelines.set(cacheKey, pipeline);
}

// ============================================================================
// Refcount: protect in-use pipelines from housekeeping eviction
// ============================================================================

/**
 * Reference count of in-flight callers holding each cached pipeline. Prevents
 * the bounded-LRU sweep in {@link getPipeline} from disposing a pipeline that
 * is currently powering another run — without this guard, one caller pushing
 * the cache over cap could release the ONNX session of a concurrent inference.
 */
const hftPipelineInUse = new Map<string, number>();

export function acquireHftPipelineInUse(cacheKey: string): void {
  hftPipelineInUse.set(cacheKey, (hftPipelineInUse.get(cacheKey) ?? 0) + 1);
}

export function releaseHftPipelineInUse(cacheKey: string): void {
  const current = hftPipelineInUse.get(cacheKey) ?? 0;
  if (current <= 1) {
    hftPipelineInUse.delete(cacheKey);
  } else {
    hftPipelineInUse.set(cacheKey, current - 1);
  }
}

export function isHftPipelineInUse(cacheKey: string): boolean {
  return (hftPipelineInUse.get(cacheKey) ?? 0) > 0;
}

/**
 * Hold an in-use refcount on `cacheKey` for the lifetime of `fn`, so a
 * concurrent LRU housekeeping pass on a different task cannot dispose this
 * task's pipeline mid-inference.
 */
export async function withHftPipelineInUse<T>(cacheKey: string, fn: () => Promise<T>): Promise<T> {
  acquireHftPipelineInUse(cacheKey);
  try {
    return await fn();
  } finally {
    releaseHftPipelineInUse(cacheKey);
  }
}

// ============================================================================
// Session cache for multi-turn conversations
// ============================================================================

interface HftSessionBase {
  readonly modelPath: string;
  /**
   * The pipeline cache key ({@link getPipelineCacheKey}) whose ONNX session
   * backs this KV-cache snapshot. When that pipeline is evicted the cached
   * tensors here are freed underneath us; the session must be swept in the
   * same step. Distinct dtype/device variants of the same `model_path`
   * (`q4:webgpu` vs `fp32:wasm`) produce different cache keys, so sweeping
   * by cache key never touches a live sibling variant's sessions.
   */
  readonly cacheKey: string;
}

export interface HftPrefixRewindSession extends HftSessionBase {
  readonly mode: "prefix-rewind";
  /** Snapshot of prefix KV entries. On each call, a fresh DynamicCache is
   *  created from these entries so generation doesn't pollute the base prefix.
   *  Safe for WASM/CPU tensors only: `DynamicCache.update()` disposes replaced
   *  GPU tensors, which would free these shared snapshot entries mid-use, so
   *  consumers must gate every rebuild on {@link hasGpuBufferEntries} and take
   *  their full re-encode fallback when it trips. */
  readonly baseEntries: Record<string, any>;
  readonly baseSeqLength: number;
  /**
   * The exact prompt text these KV entries encode (rendered prefix for a
   * warm-up, prompt + reply for a post-turn snapshot). Consumers check
   * `prompt.startsWith(encodedText)` before trusting the cached tokens,
   * instead of re-rendering the checkpoint prefix on every call. Absent on
   * entries whose rendered text was not knowable at snapshot time.
   */
  readonly encodedText?: string | undefined;
}

export interface HftProgressiveSession extends HftSessionBase {
  readonly mode: "progressive";
  /** Live DynamicCache that grows with the conversation. */
  readonly cache: DynamicCache;
}

export type HftSessionState = HftPrefixRewindSession | HftProgressiveSession;

const hftSessions = new Map<string, HftSessionState>();

export function getHftSession(sessionId: string): HftSessionState | undefined {
  return hftSessions.get(sessionId);
}

export function setHftSession(sessionId: string, state: HftSessionState): void {
  hftSessions.set(sessionId, state);
}

/**
 * Snapshot a DynamicCache-shaped flat record into a prefix-rewind session and
 * store it under `sessionId`. Owns the entry shape (own-key copy — class
 * methods live on the prototype so `Object.keys` yields only tensors) and the
 * `get_seq_length` guard, so every snapshot site stays consistent.
 *
 * @param encodedText - The exact prompt text the cache encodes (see
 *   {@link HftPrefixRewindSession.encodedText}); omit when unknowable.
 */
export function snapshotHftSession(
  sessionId: string,
  cache: Record<string, any>,
  modelPath: string,
  cacheKey: string,
  encodedText?: string | undefined
): HftPrefixRewindSession {
  const baseEntries: Record<string, any> = {};
  for (const key of Object.keys(cache)) {
    baseEntries[key] = cache[key];
  }
  const session: HftPrefixRewindSession = {
    mode: "prefix-rewind",
    baseEntries,
    baseSeqLength: typeof cache.get_seq_length === "function" ? cache.get_seq_length() : 0,
    modelPath,
    cacheKey,
    encodedText,
  };
  setHftSession(sessionId, session);
  return session;
}

/**
 * True when any snapshot entry lives in a GPU buffer. Rebuilding a
 * `DynamicCache` from such entries is a use-after-free trap: the first decode
 * step's `update()` disposes the replaced gpu-buffer tensors — which ARE the
 * shared snapshot's — so a later consumer of the same snapshot would read
 * freed GPU memory. Attach sites must skip KV reuse (full re-encode fallback)
 * when this trips.
 */
export function hasGpuBufferEntries(entries: Record<string, any>): boolean {
  for (const tensor of Object.values(entries)) {
    if (tensor?.location === "gpu-buffer") {
      return true;
    }
  }
  return false;
}

function disposeSessionResources(session: HftSessionState): void {
  if (session.mode === "progressive") {
    try {
      // DynamicCache.dispose() is async; swallow rejections from tensors that
      // generation's update() already disposed.
      const result = session.cache?.dispose?.();
      void (result as Promise<void> | undefined)?.catch?.(() => {});
    } catch {
      // Already-disposed tensors must not break session teardown.
    }
  } else {
    for (const tensor of Object.values(session.baseEntries)) {
      if (tensor?.location === "gpu-buffer" && typeof tensor.dispose === "function") {
        try {
          tensor.dispose();
        } catch {
          // Double-dispose is expected when a consumer's update() already
          // replaced (and disposed) a shared gpu-buffer entry.
        }
      }
    }
  }
}

export function deleteHftSession(sessionId: string): boolean {
  const session = hftSessions.get(sessionId);
  if (session) {
    disposeSessionResources(session);
  }
  return hftSessions.delete(sessionId);
}

export function disposeHftSessionsForModel(modelPath: string): void {
  for (const [id, state] of hftSessions) {
    if (state.modelPath === modelPath) {
      disposeSessionResources(state);
      hftSessions.delete(id);
    }
  }
}

/**
 * Sweep every session whose {@link HftSessionBase.cacheKey} matches
 * `cacheKey`, disposing resources and deleting the entry. Called from
 * {@link removeCachedPipeline} after the pipeline's ONNX session has been
 * disposed: the session's cached `baseEntries`/`cache` are tensors backed
 * by that ONNX session, so leaving them in `hftSessions` would let a later
 * `generateTurn` rebuild a `DynamicCache` from freed GPU buffers (WebGPU
 * UAF) or a corrupted WASM heap.
 *
 * Per-cacheKey (not per-modelPath) so a distinct dtype/device variant of
 * the same model that is still cached and in-use is not affected.
 */
export function disposeHftSessionsForCacheKey(cacheKey: string): void {
  for (const [id, state] of hftSessions) {
    if (state.cacheKey === cacheKey) {
      disposeSessionResources(state);
      hftSessions.delete(id);
    }
  }
}

/**
 * In-flight pipeline loads by cache key. Ensures only one load per model at a
 * time to avoid corrupt ONNX files (Protobuf parsing failed). Joining callers
 * wait on the entry cancellably (see {@link getPipeline}).
 *
 * @internal Exported for unit tests.
 */
export const pipelineLoadPromises = new Map<string, Promise<any>>();

/**
 * Vision/image pipeline types that require an image processor to be loaded.
 * If the processor is null after pipeline creation the model cache is incomplete
 * (e.g. `preprocessor_config.json` was not downloaded) and the load should be
 * treated as a retriable failure so the missing files are re-fetched.
 */
const IMAGE_PIPELINE_TYPES = new Set([
  "image-classification",
  "image-segmentation",
  "object-detection",
  "image-to-text",
  "image-feature-extraction",
  "zero-shot-image-classification",
  "depth-estimation",
  "mask-generation",
]);

/**
 * Error message prefix used when an image pipeline's processor failed to
 * initialize (null processor after load). The prefix is checked in
 * `AiJob.classifyProviderError()` to produce a `RetryableJobError` so the
 * queue re-downloads missing processor config files.
 */
export const HFT_NULL_PROCESSOR_PREFIX = "HFT_NULL_PROCESSOR:";

/**
 * Clear all cached pipelines. Best-effort awaits `model.dispose()` on each
 * pipeline so its ONNX sessions release their WASM memory before the cache
 * is cleared. transformers.js's dispose is async (it awaits `session.release()`
 * on every session in `model.sessions`); calling it synchronously would
 * fire-and-forget the WASM release.
 */
export async function clearPipelineCache(): Promise<void> {
  const snapshot = Array.from(pipelines.values());
  pipelines.clear();
  // Sessions cache tensors backed by these ONNX sessions; leaving them behind
  // would surface stale entries whose underlying buffers are freed.
  for (const session of hftSessions.values()) {
    disposeSessionResources(session);
  }
  hftSessions.clear();
  await Promise.allSettled(
    snapshot.map(async (pipeline) => {
      try {
        const model = pipeline?.model;
        await model?.dispose?.();
      } catch {
        // Best-effort: a dispose failure on one pipeline must not block others.
      }
    })
  );
}

export function hasCachedPipeline(cacheKey: string): boolean {
  return pipelines.has(cacheKey);
}

/**
 * Remove a pipeline from the cache and asynchronously dispose its underlying
 * ONNX sessions. transformers.js's `model.dispose()` is async — it iterates
 * `model.sessions` and awaits `session.release?.()` on each, which is what
 * actually frees the WASM session memory. Dropping the JS reference alone
 * leaks ONNX sessions because the WASM heap doesn't shrink in response to V8
 * GC; explicit `release()` is required.
 *
 * Returns the model.dispose() promise; callers that can await it should
 * (e.g. inside HFT_DownloadRemove's async generator) so the WASM release completes
 * before the next operation. Best-effort: dispose failure does not prevent
 * cache eviction.
 *
 * Skips (returns `false`) when the pipeline is currently in-use — releasing
 * its ONNX session out from under a concurrent inference would crash the
 * WASM worker. Callers doing housekeeping should pick a different candidate.
 */
export async function removeCachedPipeline(cacheKey: string): Promise<boolean> {
  if (isHftPipelineInUse(cacheKey)) {
    return false;
  }
  const pipeline = pipelines.get(cacheKey);
  const deleted = pipelines.delete(cacheKey);
  if (pipeline) {
    try {
      const model = pipeline?.model;
      await model?.dispose?.();
    } catch {
      // Best-effort: dispose failure must not propagate.
    }
  }
  if (deleted) {
    // Any KV-cache session stamped with this cacheKey now points at freed
    // ONNX-session tensors; sweep it before a later turn tries to rebuild
    // a DynamicCache from those tensors.
    disposeHftSessionsForCacheKey(cacheKey);
  }
  return deleted;
}

/**
 * Iterate cached pipelines in LRU order and dispose the first non-in-use
 * candidate, skipping `exceptKey` (the freshly loaded pipeline the caller
 * must not evict). Returns the evicted cache key, or `undefined` when every
 * eligible pipeline is currently in-use (in which case the caller should
 * leave the cache over cap for this cycle — a housekeeping eviction must
 * never block active inference).
 */
async function evictLeastRecentlyUsedPipeline(
  exceptKey: string | undefined
): Promise<string | undefined> {
  for (const key of pipelines.keys()) {
    if (key === exceptKey) continue;
    if (isHftPipelineInUse(key)) continue;
    const removed = await removeCachedPipeline(key);
    if (removed) return key;
  }
  return undefined;
}

/**
 * Bring the pipeline cache back to at most {@link MAX_CACHED_PIPELINES} by
 * evicting LRU non-in-use entries. `exceptKey` is the freshly loaded pipeline
 * that must not be evicted. If every other eviction candidate is in-use,
 * leaves the cache over cap for this cycle — housekeeping never blocks or
 * waits on active inference.
 */
async function enforcePipelineCacheCap(exceptKey: string): Promise<void> {
  while (pipelines.size > MAX_CACHED_PIPELINES) {
    const evicted = await evictLeastRecentlyUsedPipeline(exceptKey);
    if (evicted === undefined) {
      getLogger().debug(
        "HFT pipeline cache over cap but every entry is in-use; deferring eviction",
        { size: pipelines.size, cap: MAX_CACHED_PIPELINES }
      );
      return;
    }
    getLogger().debug("HFT pipeline cache evicted LRU entry", { evicted });
  }
}

/**
 * Generate a cache key for a pipeline that includes all configuration options
 * that affect pipeline creation (model_path, pipeline, dtype, device)
 */
export function getPipelineCacheKey(model: HfTransformersOnnxModelConfig): string {
  const dtype = model.provider_config.dtype || "";
  const device = model.provider_config.device || "";
  const revision = model.provider_config.revision || "main";
  return `${model.provider_config.model_path}:${model.provider_config.pipeline}:${dtype}:${device}:${revision}`;
}

/**
 * Helper function to get a pipeline for a model
 * @param progressScaleMax - Maximum progress value for download phase (100 for download-only, 10 for download+run)
 *
 * Explicit `Promise<any>` return avoids TS2883 (inferred type not portable across package boundaries).
 */
export async function getPipeline(
  model: HfTransformersOnnxModelConfig,
  emit: (event: StreamPhase) => void,
  options: PretrainedModelOptions = {},
  signal?: AbortSignal,
  progressScaleMax: number = 10
): Promise<any> {
  if (signal?.aborted) {
    throw signal?.reason ?? new Error("Aborted");
  }
  const cacheKey = getPipelineCacheKey(model);
  if (pipelines.has(cacheKey)) {
    getLogger().debug("HFT pipeline cache hit", { cacheKey });
    touchPipeline(cacheKey);
    return pipelines.get(cacheKey);
  }

  // In-flight: only one load per model at a time to avoid concurrent writes to the same
  // ONNX cache path (which can yield "Protobuf parsing failed" when one process reads while another writes).
  const inFlight = pipelineLoadPromises.get(cacheKey);
  if (inFlight) {
    // Tell the caller why nothing is happening yet — without this the task
    // sits on its initial "Starting download…" state with no progress event.
    emit({
      type: "phase",
      message: "Waiting for an earlier load of this model to finish",
      progress: undefined,
    });
    try {
      // Race the join against this caller's own signal. A join that only
      // awaited the other load could not be cancelled at all: the worker
      // reports the abort back to the main thread immediately, so the caller
      // believed it had cancelled while this promise sat here forever.
      await raceWithAbort(inFlight, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Pipeline load aborted");
      }
      // First load failed (e.g. aborted) — fall through to retry below.
    }
    const cached = pipelines.get(cacheKey);
    if (cached) return cached;
    // Load failed for the other caller; fall through to retry (we remove from map in finally).
  }

  // The aborted load is deliberately left in the map until it settles. Abort
  // tears down its in-flight fetch synchronously (see wrapAbortableResponse),
  // so the unwind is prompt whenever the load is in a download phase; when it
  // is instead inside ONNX session creation — which cannot be interrupted —
  // a retry must wait rather than build a second multi-GB session alongside
  // it. transformers.js also dedupes per-file downloads internally, so a
  // retry that raced ahead would only join that lower-level in-flight load.
  const loadPromise = doGetPipeline(model, emit, options, progressScaleMax, cacheKey, signal);
  pipelineLoadPromises.set(cacheKey, loadPromise);
  return loadPromise.finally(() => {
    // Only delete our own entry so a later load that replaced it is left alone.
    if (pipelineLoadPromises.get(cacheKey) === loadPromise) {
      pipelineLoadPromises.delete(cacheKey);
    }
  });
}

/**
 * Await `promise`, but reject as soon as `signal` fires. Listener is removed
 * once the promise settles so a long-lived signal doesn't accumulate closures.
 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("Aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

const doGetPipeline = async (
  model: HfTransformersOnnxModelConfig,
  emit: (event: StreamPhase) => void,
  options: PretrainedModelOptions,
  progressScaleMax: number,
  cacheKey: string,
  signal?: AbortSignal
) => {
  // Throttle state for progress events
  let lastProgressTime = 0;
  let pendingProgress: number | null = null;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  const THROTTLE_MS = 160;

  /**
   * Sends a progress event, throttled to avoid flooding the worker channel.
   * Always sends first event and final (>=progressScaleMax) immediately.
   */
  const sendProgress = (progress: number): void => {
    const now = Date.now();
    const timeSinceLastEvent = now - lastProgressTime;
    const isFirst = lastProgressTime === 0;
    const isFinal = progress >= progressScaleMax;

    if (isFirst || isFinal) {
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      pendingProgress = null;
      emit({ type: "phase", message: "Downloading model", progress: Math.round(progress) });
      lastProgressTime = now;
      return;
    }

    if (timeSinceLastEvent < THROTTLE_MS) {
      pendingProgress = progress;
      if (!throttleTimer) {
        const timeRemaining = Math.max(1, THROTTLE_MS - timeSinceLastEvent);
        throttleTimer = setTimeout(() => {
          throttleTimer = null;
          if (pendingProgress !== null) {
            emit({
              type: "phase",
              message: "Downloading model",
              progress: Math.round(pendingProgress),
            });
            lastProgressTime = Date.now();
            pendingProgress = null;
          }
        }, timeRemaining);
      }
      return;
    }

    emit({ type: "phase", message: "Downloading model", progress: Math.round(progress) });
    lastProgressTime = now;
    pendingProgress = null;
  };

  // Get the abort signal from the signal parameter
  const abortSignal = signal;

  // Register a per-model AbortController so abortableFetch can cancel in-flight fetches
  const modelPath = model.provider_config.model_path;
  const modelController = new AbortController();
  let controllers = modelAbortControllers.get(modelPath);
  if (!controllers) {
    controllers = new Set();
    modelAbortControllers.set(modelPath, controllers);
  }
  controllers.add(modelController);
  if (abortSignal) {
    if (abortSignal.aborted) {
      modelController.abort();
    } else {
      abortSignal.addEventListener("abort", () => modelController.abort(), { once: true });
    }
  }

  // Use aggregate progress_total event from @huggingface/transformers v4 pipeline()
  const progressCallback = (status: ProgressInfo) => {
    if (abortSignal?.aborted) return;

    if (status.status === "progress_total") {
      const scaledProgress = (status.progress * progressScaleMax) / 100;
      sendProgress(scaledProgress);
    }
  };

  const device = resolveHftPipelineDevice(model.provider_config.device);

  const dtype = model.provider_config.dtype || "";
  const pipelineOptions: PretrainedModelOptions = {
    revision: model.provider_config.revision || "main",
    ...(model.provider_config.use_external_data_format
      ? { useExternalDataFormat: model.provider_config.use_external_data_format }
      : {}),
    ...(dtype ? { dtype: dtype as any } : {}),
    ...(device ? { device: device as any } : {}),
    ...options,
    progress_callback: progressCallback,
  };

  // Check if already aborted before starting
  if (abortSignal?.aborted) {
    removeModelController(modelPath, modelController);
    throw new Error("Operation aborted before pipeline creation");
  }

  const pipelineType = model.provider_config.pipeline;

  const { pipeline } = await loadTransformersSDK();

  const logger = getLogger();
  const pipelineTimerLabel = `hft:pipeline:${cacheKey}`;
  logger.time(pipelineTimerLabel, { pipelineType, modelPath });

  try {
    const result = await pipeline(pipelineType, model.provider_config.model_path, pipelineOptions);

    // Flush pending throttled progress and clean up timer
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    // pendingProgress may have been set by progressCallback during the pipeline() await
    if (pendingProgress !== null) {
      emit({
        type: "phase",
        message: "Downloading model",
        progress: Math.round(pendingProgress),
      });
      pendingProgress = null;
    }

    // Check if aborted after pipeline creation
    if (abortSignal?.aborted) {
      logger.timeEnd(pipelineTimerLabel, { status: "aborted" });
      throw new Error("Operation aborted after pipeline creation");
    }

    // For image/vision pipelines the processor must be initialized. A null processor
    // means the model cache is incomplete (e.g. preprocessor_config.json was not
    // downloaded, likely because a previous download was aborted). Throw a specific
    // error so the job queue can retry and re-fetch the missing files.
    if (IMAGE_PIPELINE_TYPES.has(pipelineType) && (result as any).processor == null) {
      throw new Error(
        `${HFT_NULL_PROCESSOR_PREFIX} Image processor not initialized for ` +
          `${pipelineType}/${modelPath}. Model cache may be incomplete.`
      );
    }

    logger.timeEnd(pipelineTimerLabel, { status: "loaded" });
    pipelines.set(cacheKey, result);
    await enforcePipelineCacheCap(cacheKey);
    return result;
  } catch (error: any) {
    logger.timeEnd(pipelineTimerLabel, { status: "error", error: String(error) });
    // If aborted, throw a clean abort error rather than internal stream errors.
    // Preserve processor-initialization errors so they propagate with their original message.
    if (
      !error?.message?.startsWith(HFT_NULL_PROCESSOR_PREFIX) &&
      (abortSignal?.aborted || modelController.signal.aborted)
    ) {
      throw new Error("Pipeline download aborted");
    }
    throw error;
  } finally {
    removeModelController(modelPath, modelController);
    const { random } = await loadTransformersSDK();
    random.seed(model.provider_config.seed ?? undefined);
  }
};
