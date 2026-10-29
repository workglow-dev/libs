/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { createEstimatedOutputUsageReporter } from "@workglow/ai/provider-utils";
import type { StreamEvent } from "@workglow/task-graph";
import type {
  LlamaContext,
  LlamaContextSequence,
  LlamaEmbeddingContext,
  Llama as LlamaInstance,
  LlamaModel,
} from "node-llama-cpp";
import { llamaCppQwenVariation, resolveLlamaCppModelProfile } from "./LlamaCpp_ModelProfiles";
import type { LlamaCppModelConfig } from "./LlamaCpp_ModelSchema";

type LlamaCppSDKModule = typeof import("node-llama-cpp");

let _sdk: LlamaCppSDKModule | undefined;
let _loadPromise: Promise<LlamaCppSDKModule> | undefined;

// NOTE: we do not want to de-dup this in the provider-utils, vite wants direct import with string literals.
export async function loadSdk(): Promise<LlamaCppSDKModule> {
  _loadPromise ??= import("node-llama-cpp")
    .then((mod) => {
      _sdk = mod;
      return mod;
    })
    .catch(() => {
      _loadPromise = undefined;
      _sdk = undefined;
      throw new Error(
        "node-llama-cpp is required for LOCAL_LLAMACPP tasks. Install it with: bun add node-llama-cpp"
      );
    });
  return _loadPromise;
}

export function getLlamaCppSdk() {
  if (!_sdk) {
    throw new Error("LlamaCpp SDK not loaded; call loadSdk() first");
  }
  return _sdk;
}

let llamaInstance: LlamaInstance | undefined;
/** @internal Used by unload task */
export const llamaCppModels = new Map<string, LlamaModel>();
/** @internal Used by unload task */
export const llamaCppTextContexts = new Map<string, LlamaContext>();
/** @internal Used by unload task */
export const llamaCppEmbeddingContexts = new Map<string, LlamaEmbeddingContext>();

/** Maps model_url (or model_path when used as URI) to the actual downloaded filesystem path. */
export const resolvedPaths = new Map<string, string>();

export interface LlamaCppSessionState {
  mode: "prefix-rewind" | "progressive";
  sequence: any; // LlamaContextSequence
  session: any; // LlamaChatSession (for progressive mode)
  modelKey: string;
}

// Shared across bundle copies via a Symbol.for key — same pattern as
// PortCodecRegistry/globalContainer. `./ai` and `./ai-runtime` are built as
// separate dist entry points; without this, inline (non-worker) usage would
// have each entry point's copy of this module see its own Map, and a session
// set through one entry point would look absent through the other.
const GLOBAL_SESSIONS_KEY = Symbol.for("@workglow/node-llama-cpp/llamaCppSessions");
const _sessionsGlobal = globalThis as Record<symbol, unknown>;
if (!_sessionsGlobal[GLOBAL_SESSIONS_KEY]) {
  _sessionsGlobal[GLOBAL_SESSIONS_KEY] = new Map<string, LlamaCppSessionState>();
}
export const llamaCppSessions = _sessionsGlobal[GLOBAL_SESSIONS_KEY] as Map<
  string,
  LlamaCppSessionState
>;

/**
 * Per-`sessionId` promise-chain mutex. The non-checkpoint shared-session paths
 * (a fingerprint session reused across same-toolset calls, or a chat's
 * `ownedSession`) read-modify-write one live `LlamaContextSequence` with async
 * gaps between the map lookup, sequence acquisition, generation, and the
 * store-back. `withSessionLock` chains same-id callers so the second waits
 * until the first has fully returned — a live sequence advances in place and
 * cannot be shared, and an unserialized double-create would overwrite the
 * first store and strand its sequence. The lock is intentionally
 * session-scoped, not global, so unrelated sessions still run in parallel.
 * (Checkpoint consumption does not take the lock: {@link stealLlamaCppSession}
 * is its atomic hand-off, and the losing consumer re-encodes on its own
 * sequence.)
 */
const sessionLocks = new Map<string, Promise<void>>();

export async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessionLocks.set(sessionId, next);
  await prev;
  try {
    return await fn();
  } finally {
    // Drop the map entry when we're the trailing waiter, so a session that
    // never runs again does not stay pinned in the map indefinitely.
    if (sessionLocks.get(sessionId) === next) {
      sessionLocks.delete(sessionId);
    }
    release();
  }
}

export function getLlamaCppSession(sessionId: string): LlamaCppSessionState | undefined {
  return llamaCppSessions.get(sessionId);
}

export function setLlamaCppSession(sessionId: string, state: LlamaCppSessionState): void {
  llamaCppSessions.set(sessionId, state);
}

/**
 * Atomic get-and-remove for a checkpoint session id. Two concurrent consumers
 * of the same immutable checkpoint would otherwise both observe the cached
 * state and both call `.generate()` on the shared `LlamaContextSequence` — a
 * live sequence advances in place and cannot be safely shared. The
 * synchronous `Map.get` + `Map.delete` here is race-free on JS's single
 * thread: exactly one caller sees the state, every subsequent caller
 * observes `undefined` and re-encodes via the existing missing-state fallback
 * (which acquires its own sequence). Intentionally NOT used by AiChatTask,
 * whose `ownedSession` mode is the caller's mutable session, not a checkpoint.
 */
export function stealLlamaCppSession(sessionId: string): LlamaCppSessionState | undefined {
  const state = llamaCppSessions.get(sessionId);
  if (state) llamaCppSessions.delete(sessionId);
  return state;
}

/** Pre-generation KV boundary captured by {@link captureSequenceTokenBoundary}. */
export interface SequenceTokenBoundary {
  /** `nextTokenIndex` before the generation — the first cell the turn wrote. */
  readonly index: number;
  /**
   * The prefix's token ids at capture time (when the sequence exposes
   * `contextTokens`), used to detect a context shift during the turn — a
   * shift rewrites cells below the boundary, making a rewind unsound.
   */
  readonly prefixTokens: readonly number[] | undefined;
}

/**
 * Capture the sequence's current token boundary before a generation so
 * {@link restoreLlamaCppCheckpointSession} can rewind back to it afterwards.
 * Returns undefined when the sequence does not expose the rewind API
 * (`nextTokenIndex` + `eraseContextTokenRanges`) — callers then skip the
 * restore and dispose the consumed session as before.
 */
export function captureSequenceTokenBoundary(sequence: any): SequenceTokenBoundary | undefined {
  if (
    typeof sequence?.nextTokenIndex !== "number" ||
    typeof sequence?.eraseContextTokenRanges !== "function"
  ) {
    return undefined;
  }
  const index = sequence.nextTokenIndex as number;
  const contextTokens = sequence.contextTokens;
  return {
    index,
    prefixTokens: Array.isArray(contextTokens)
      ? (contextTokens.slice(0, index) as number[])
      : undefined,
  };
}

/**
 * Rewind a consumed checkpoint session back to its pre-generation prefix state
 * and re-register it under the checkpoint id, so "warm once, consume many"
 * holds: consuming steals the warmed session out of the map, and without a
 * restore the parent checkpoint's KV state would be destroyed on first
 * consumption, forcing every later consumer to silently pay a full prefix
 * re-encode.
 *
 * KV cells past the boundary are erased via `eraseContextTokenRanges` (start
 * inclusive, end exclusive) and the JS-side chat history is reset to
 * `prefixHistory` (the same rendering the warm-up encoded), so the next
 * consumer's generation aligns against exactly the warmed prefix tokens.
 *
 * Returns true when the map owns the session again. Returns false — the
 * caller must then dispose the session, so post-generation state is never
 * left registered under the checkpoint id — when the rewind API is
 * unavailable, the rewind fails, the prefix cells were rewritten by a context
 * shift during the turn, or a concurrent consumer (one that lost the steal
 * and re-encoded on its own sequence) restored the id first.
 */
export async function restoreLlamaCppCheckpointSession(
  sessionId: string,
  state: LlamaCppSessionState,
  prefixBoundary: SequenceTokenBoundary | undefined,
  prefixHistory: any[]
): Promise<boolean> {
  if (prefixBoundary === undefined) return false;
  if (llamaCppSessions.has(sessionId)) return false;
  try {
    const end = state.sequence?.nextTokenIndex;
    if (typeof end !== "number" || end < prefixBoundary.index) return false;
    // A context shift during the turn (context overflow) deletes/rewrites
    // cells below the boundary; verify the prefix token ids are intact before
    // trusting a positional rewind.
    if (prefixBoundary.prefixTokens !== undefined) {
      const current = state.sequence?.contextTokens;
      if (!Array.isArray(current)) return false;
      for (let i = 0; i < prefixBoundary.index; i++) {
        if (current[i] !== prefixBoundary.prefixTokens[i]) return false;
      }
    }
    if (end > prefixBoundary.index) {
      await state.sequence.eraseContextTokenRanges([{ start: prefixBoundary.index, end }]);
    }
    state.session?.setChatHistory?.(prefixHistory);
    // Re-check after the awaited rewind: a concurrent consumer may have
    // restored its own re-encoded session under this id in the meantime.
    if (llamaCppSessions.has(sessionId)) return false;
    llamaCppSessions.set(sessionId, state);
    return true;
  } catch {
    return false;
  }
}

export async function deleteLlamaCppSession(sessionId: string): Promise<boolean> {
  const session = llamaCppSessions.get(sessionId);
  if (session) {
    try {
      await session.session?.dispose?.({ disposeSequence: false });
    } catch {}
    try {
      await session.sequence?.dispose?.();
    } catch {}
  }
  return llamaCppSessions.delete(sessionId);
}

/**
 * Eagerly dispose every cached chat session and its sequence, freeing the
 * underlying `LlamaContext` sequence-pool slots without tearing down the
 * shared contexts or models. Intended for use between unrelated test blocks
 * (or long-lived runtimes) where leftover sessions would otherwise exhaust
 * the per-context sequence pool.
 */
export async function releaseLlamaCppTransientSessions(): Promise<void> {
  for (const id of Array.from(llamaCppSessions.keys())) {
    await deleteLlamaCppSession(id);
  }
  llamaCppSessions.clear();
}

/**
 * Last-resort recovery: dispose the cached text `LlamaContext` for a given
 * model key (its sequences are released along with it) and drop it from the
 * cache so the next request rebuilds a fresh context. Sessions that referenced
 * the context are released first.
 *
 * `modelKey` accepts either the config key (typically `model_url`) or the
 * resolved on-disk path; both spellings are tried so callers don't have to
 * know which form ended up in the context cache.
 *
 * If `reloadModel` is true the cached `LlamaModel` and any cached embedding
 * context for the same key are disposed as well, so the next request reloads
 * weights from disk.
 */
export async function recycleLlamaCppTextContext(
  modelKey: string,
  options: { readonly reloadModel?: boolean } = {}
): Promise<void> {
  await disposeLlamaCppSessionsForModel(modelKey);
  const resolved = resolvedPaths.get(modelKey);
  const candidates = resolved && resolved !== modelKey ? [modelKey, resolved] : [modelKey];
  for (const key of candidates) {
    const context = llamaCppTextContexts.get(key);
    if (context) {
      llamaCppTextContexts.delete(key);
      await (context as unknown as { dispose?: () => Promise<void> }).dispose?.().catch(() => {});
    }
  }
  if (options.reloadModel) {
    for (const key of candidates) {
      const embeddingContext = llamaCppEmbeddingContexts.get(key);
      if (embeddingContext) {
        llamaCppEmbeddingContexts.delete(key);
        await (embeddingContext as unknown as { dispose?: () => Promise<void> })
          .dispose?.()
          .catch(() => {});
      }
      const loadedModel = llamaCppModels.get(key);
      if (loadedModel) {
        llamaCppModels.delete(key);
        await loadedModel.dispose().catch(() => {});
      }
    }
  }
}

export async function disposeLlamaCppSessionsForModel(modelKey: string): Promise<void> {
  for (const [id, state] of llamaCppSessions) {
    // Sessions are stored with `modelKey = getConfigKey(model)` (typically the
    // caller's `model_url`), but callers may dispose by the resolved on-disk
    // path (e.g. `evictLeastRecentlyUsedModel` iterates `llamaCppModels` keys,
    // which are resolved paths). Match on both spellings so eviction actually
    // clears the session state instead of stranding it against a disposed model.
    const matches = state.modelKey === modelKey || resolvedPaths.get(state.modelKey) === modelKey;
    if (matches) {
      try {
        await state.session?.dispose?.({ disposeSequence: false });
      } catch {}
      try {
        await state.sequence?.dispose?.();
      } catch {}
      llamaCppSessions.delete(id);
    }
  }
}

export async function getLlamaInstance(): Promise<LlamaInstance> {
  if (!llamaInstance) {
    const { getLlama } = await loadSdk();
    llamaInstance = await getLlama();
  }
  return llamaInstance;
}

export function getConfigKey(model: LlamaCppModelConfig): string {
  return model.provider_config.model_url ?? model.provider_config.model_path;
}

export function getActualModelPath(model: LlamaCppModelConfig): string {
  const key = getConfigKey(model);
  const resolved = resolvedPaths.get(key);
  return resolved ?? model.provider_config.model_path;
}

/**
 * Substrings (lower-cased) that identify a device-memory allocation failure
 * across ggml backends (CUDA, Metal, ROCm/HIP, Vulkan, generic ggml). Any
 * single match on the lowercased error message is enough — a flat OR beats
 * the previous two-gate design, which missed messages that spelled the
 * backend without one of the "vram|cuda|gpu" tokens (Metal / ROCm / Vulkan)
 * or that used allocation phrases outside the previous whitelist.
 */
const VRAM_ERROR_PATTERNS: readonly string[] = [
  "not enough vram",
  "too large for the available vram",
  "out of memory",
  "failed to allocate",
  "cuda out of memory",
  "cudamalloc",
  "ggml_backend_cuda",
  "ggml_cuda",
  "cublas",
  "allocating buffer",
  "allocation failed",
  "mtlbuffer",
  "metal allocation",
  "hipmalloc",
  "hip out of memory",
  "vkdevicememory",
  "vk_error_out_of_device_memory",
];

/** @internal exported for unit tests. */
export function isVramError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return VRAM_ERROR_PATTERNS.some((pattern) => msg.includes(pattern));
}

/** Move a cached model to the most-recently-used end of the insertion-ordered cache. */
function touchModel(modelPath: string): void {
  const cached = llamaCppModels.get(modelPath);
  if (cached) {
    llamaCppModels.delete(modelPath);
    llamaCppModels.set(modelPath, cached);
  }
}

/**
 * Reference count of in-flight callers using each cached model path. Prevents
 * {@link evictLeastRecentlyUsedModel} from disposing a model that is currently
 * powering another run — without this guard, one caller's VRAM OOM can pull
 * the `LlamaModel` (and its contexts / sessions) out from under a concurrent
 * task on a different model.
 */
const modelInUse = new Map<string, number>();

export function acquireModelInUse(modelPath: string): void {
  modelInUse.set(modelPath, (modelInUse.get(modelPath) ?? 0) + 1);
}

export function releaseModelInUse(modelPath: string): void {
  const current = modelInUse.get(modelPath) ?? 0;
  if (current <= 1) {
    modelInUse.delete(modelPath);
  } else {
    modelInUse.set(modelPath, current - 1);
  }
}

/** @internal exported for unit tests. */
export function isModelInUse(modelPath: string): boolean {
  return (modelInUse.get(modelPath) ?? 0) > 0;
}

/**
 * Acquire an in-use refcount on `modelPath` for the lifetime of `fn`, so a
 * concurrent LRU eviction on a different task cannot dispose this task's
 * model / context / session mid-flight.
 */
export async function withModelInUse<T>(modelPath: string, fn: () => Promise<T>): Promise<T> {
  acquireModelInUse(modelPath);
  try {
    return await fn();
  } finally {
    releaseModelInUse(modelPath);
  }
}

/**
 * Evict the least-recently-used cached model (and its text context) to free
 * VRAM, skipping `exceptPath` (the model currently being loaded) and any model
 * with a live in-use refcount. `llamaCppModels` is kept in access order by
 * {@link touchModel}, so the first eligible key is the LRU one. Returns the
 * evicted path, or undefined when every non-`exceptPath` candidate is in use
 * (in which case the caller's VRAM error propagates unchanged).
 */
async function evictLeastRecentlyUsedModel(exceptPath: string): Promise<string | undefined> {
  for (const path of llamaCppModels.keys()) {
    if (path === exceptPath) continue;
    if (isModelInUse(path)) continue;
    await recycleLlamaCppTextContext(path, { reloadModel: true });
    return path;
  }
  return undefined;
}

/**
 * Run `attempt`, and if it fails with a VRAM allocation error, evict the LRU
 * cached model and retry — repeating until it succeeds or there is nothing left
 * to evict (then the original error is rethrown, unchanged). This lets a large
 * model or a large KV cache load by reclaiming VRAM still held by earlier
 * models the worker cached but no longer needs (e.g. successive candidates in
 * an eval sweep). In-use models are skipped by {@link evictLeastRecentlyUsedModel}.
 */
export async function withVramEviction<T>(
  exceptPath: string,
  attempt: () => Promise<T>
): Promise<T> {
  while (true) {
    try {
      return await attempt();
    } catch (err) {
      if (!isVramError(err)) throw err;
      const evicted = await evictLeastRecentlyUsedModel(exceptPath);
      if (evicted === undefined) throw err;
    }
  }
}

export async function getOrLoadModel(model: LlamaCppModelConfig): Promise<LlamaModel> {
  const modelPath = getActualModelPath(model);
  const cached = llamaCppModels.get(modelPath);
  if (cached) {
    touchModel(modelPath);
    return cached;
  }

  const llama = await getLlamaInstance();
  const config = model.provider_config;

  const loadedModel = await withVramEviction(modelPath, () =>
    llama.loadModel({
      modelPath,
      ...(config.gpu_layers !== undefined && { gpuLayers: config.gpu_layers }),
    })
  );

  llamaCppModels.set(modelPath, loadedModel);
  return loadedModel;
}

/** Spread into `LlamaChatSession.prompt` options when `provider_config.seed` is set. */
export function llamaCppSeedPromptSpread(
  provider_config: LlamaCppModelConfig["provider_config"]
): { seed: number } | Record<string, never> {
  return provider_config.seed !== undefined ? { seed: provider_config.seed } : {};
}

/**
 * Spread into {@link LlamaChatSession} constructor when the model's profile
 * names a chat wrapper; otherwise node-llama-cpp resolves one from the GGUF.
 */
export function llamaCppChatSessionConstructorSpread(model: LlamaCppModelConfig) {
  const variation = llamaCppQwenVariation(resolveLlamaCppModelProfile(model).profile);
  if (!variation) {
    return {};
  }
  const { QwenChatWrapper } = getLlamaCppSdk();
  return { chatWrapper: new QwenChatWrapper({ variation }) };
}

export async function getOrCreateTextContext(model: LlamaCppModelConfig): Promise<LlamaContext> {
  const modelPath = getActualModelPath(model);
  const cached = llamaCppTextContexts.get(modelPath);
  if (cached) {
    touchModel(modelPath);
    return cached;
  }

  const loadedModel = await getOrLoadModel(model);
  const config = model.provider_config;

  // Evict other cached models on a VRAM error so the KV cache can fit; keep this
  // model (modelPath) resident since we are building its context.
  const context = await withVramEviction(modelPath, () =>
    loadedModel.createContext({
      ...(config.context_size && { contextSize: config.context_size }),
      ...(config.flash_attention !== undefined && { flashAttention: config.flash_attention }),
    })
  );

  llamaCppTextContexts.set(modelPath, context);
  return context;
}

/**
 * Create a NEW, **uncached** text context for a one-shot generation; the caller
 * owns it and must dispose it when done.
 *
 * Independent generations (e.g. an eval sweep, or successive structured-output
 * calls) must NOT share {@link getOrCreateTextContext}'s cached context: the
 * second generation acquires a sequence from the same context while the first
 * generation's sequence teardown is still in flight (the reclaim runs inside an
 * async `withLock([context])` callback). That race surfaces either as
 * `"No sequences left"` or — on some model architectures (observed with Gemma) —
 * a native use-after-free **segfault** on the second generation. A fresh context
 * has its own sequence pool and no prior-generation teardown pending, so both
 * failure modes disappear. The `LlamaModel` stays cached via
 * {@link getOrLoadModel}, so only the KV cache is rebuilt, not the weights.
 */
export async function createDisposableTextContext(
  model: LlamaCppModelConfig
): Promise<LlamaContext> {
  const modelPath = getActualModelPath(model);
  const loadedModel = await getOrLoadModel(model);
  const config = model.provider_config;
  return withVramEviction(modelPath, () =>
    loadedModel.createContext({
      ...(config.context_size && { contextSize: config.context_size }),
      ...(config.flash_attention !== undefined && { flashAttention: config.flash_attention }),
    })
  );
}

/** How long {@link acquireContextSequence} waits for a disposed sequence to be reclaimed. */
const SEQUENCE_RECLAIM_TIMEOUT_MS = 30_000;
/** node-llama-cpp currently throws this message from `getSequence()` when no slots are available. */
const NO_SEQUENCES_LEFT_ERROR_SUBSTRING = "no sequences left";

/**
 * Acquire a sequence from a (typically cached, single-sequence) context, tolerating
 * node-llama-cpp's **asynchronous** sequence reclamation.
 *
 * `LlamaContextSequence.dispose()` returns synchronously, but it frees the sequence
 * id via `_reclaimUnusedSequenceId`, which pushes the id back into the context's pool
 * inside a `withLock([context])` async callback — so the slot is not actually free
 * when `dispose()` returns. On a cached single-sequence context, a fast serial
 * re-acquire (the next task reusing the same context) can therefore observe
 * `sequencesLeft === 0` and make `getSequence()` throw `"No sequences left"`, even
 * though the previous sequence was disposed. It is a race, not a leak — which is why
 * it surfaces on slow models (large sections, MoE) but not on fast ones.
 *
 * Waiting for `sequencesLeft > 0` before allocating closes the race without growing
 * the sequence pool (each extra sequence costs another `contextSize` of KV cells, so
 * a larger pool would regress memory on VRAM-constrained hosts).
 */
export async function acquireContextSequence(
  context: LlamaContext,
  signal?: AbortSignal
): Promise<LlamaContextSequence> {
  const abortReason = (): Error => {
    const raw = (signal as { reason?: unknown } | undefined)?.reason;
    return raw instanceof Error ? raw : new Error("acquireContextSequence aborted");
  };

  const deadline = Date.now() + SEQUENCE_RECLAIM_TIMEOUT_MS;
  while (true) {
    if (signal?.aborted) throw abortReason();
    if (context.sequencesLeft > 0) {
      try {
        return context.getSequence();
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
        if (!msg.includes(NO_SEQUENCES_LEFT_ERROR_SUBSTRING)) {
          throw err;
        }
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        "Timed out waiting for a llama.cpp context sequence to be reclaimed after dispose."
      );
    }
    // Yield a macrotask so the lock-guarded reclaim callback can run. Short-circuit
    // the wait on abort so a queued cancellation doesn't have to burn a full poll tick.
    await new Promise<void>((resolve) => {
      let onAbort: (() => void) | null = null;
      const timer = setTimeout(() => {
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, 1);
      if (signal) {
        onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

/**
 * Acquire a sequence, run `body`, and always dispose the sequence — even when
 * `body` throws (e.g. a `LlamaChatSession` / `LlamaChat` constructor throwing
 * partway through, which would otherwise strand the sequence and eventually
 * exhaust the per-context sequence pool).
 */
export async function withSequence<T>(
  context: LlamaContext,
  body: (sequence: LlamaContextSequence) => Promise<T>,
  options: { readonly signal?: AbortSignal } = {}
): Promise<T> {
  const sequence = await acquireContextSequence(context, options.signal);
  try {
    return await body(sequence);
  } finally {
    try {
      await sequence.dispose();
    } catch {
      // best-effort dispose
    }
  }
}

export async function getOrCreateEmbeddingContext(
  model: LlamaCppModelConfig
): Promise<LlamaEmbeddingContext> {
  const modelPath = getActualModelPath(model);
  const cached = llamaCppEmbeddingContexts.get(modelPath);
  if (cached) {
    touchModel(modelPath);
    return cached;
  }

  const loadedModel = await getOrLoadModel(model);

  const context = await withVramEviction(modelPath, () => loadedModel.createEmbeddingContext());

  llamaCppEmbeddingContexts.set(modelPath, context);
  return context;
}

/**
 * Drive a node-llama-cpp `prompt` that pushes text via `onTextChunk`, yielding
 * `text-delta` events (and provisional `usage` snapshots) as they arrive.
 *
 * Pass `promptText` so ↑ appears before the first decode token — node-llama-cpp
 * surfaces no billed usage on its prompt API, so the estimate is the only live
 * counter the CLI can show. `finish` still carries no usage (absent, not zero).
 */
export async function* streamFromSession<T extends Record<string, unknown>>(
  promptFn: (onTextChunk: (chunk: string) => void) => Promise<string>,
  signal: AbortSignal,
  options: { readonly promptText?: string | undefined } = {}
): AsyncGenerator<StreamEvent<T>> {
  const queue: string[] = [];
  const pendingUsage: StreamEvent<T>[] = [];
  let isComplete = false;
  let completionError: unknown;
  let resolveWait: (() => void) | null = null;

  const notifyWaiter = () => {
    resolveWait?.();
    resolveWait = null;
  };

  const provisionalUsage = createEstimatedOutputUsageReporter((event) => {
    pendingUsage.push(event as StreamEvent<T>);
    notifyWaiter();
  });
  if (options.promptText !== undefined) {
    provisionalUsage.onPrompt(options.promptText);
  }

  const promptPromise = promptFn((chunk: string) => {
    queue.push(chunk);
    provisionalUsage.onText(chunk);
    notifyWaiter();
  })
    .then(() => {
      isComplete = true;
      notifyWaiter();
    })
    .catch((err: unknown) => {
      completionError = err;
      isComplete = true;
      notifyWaiter();
    });

  const drain = function* (): Generator<StreamEvent<T>> {
    while (pendingUsage.length > 0) {
      yield pendingUsage.shift()!;
    }
    while (queue.length > 0) {
      yield { type: "text-delta", port: "text", textDelta: queue.shift()! };
    }
  };

  try {
    while (true) {
      yield* drain();
      if (isComplete) break;
      await new Promise<void>((r) => {
        resolveWait = r;
      });
    }
    yield* drain();
  } finally {
    await promptPromise.catch(() => {});
  }

  if (completionError) {
    if (signal.aborted) return;
    throw completionError;
  }

  provisionalUsage.flush();
  yield* drain();
  // No usage on finish: node-llama-cpp reports none. Mid-stream snapshots already
  // settled via StreamProcessor's `event.usage ?? liveUsage` path.
  yield { type: "finish", data: {} as T };
}

export async function disposeLlamaCppResources(): Promise<void> {
  // Dispose all sessions before contexts/models they reference
  for (const id of Array.from(llamaCppSessions.keys())) {
    await deleteLlamaCppSession(id);
  }

  const disposeAll = async (map: Map<string, { dispose(): Promise<void> }>) => {
    for (const resource of map.values()) {
      await resource.dispose().catch(() => {});
    }
    map.clear();
  };

  await disposeAll(llamaCppTextContexts as Map<string, { dispose(): Promise<void> }>);
  await disposeAll(llamaCppEmbeddingContexts as Map<string, { dispose(): Promise<void> }>);
  await disposeAll(llamaCppModels as Map<string, { dispose(): Promise<void> }>);

  if (llamaInstance) {
    await llamaInstance.dispose?.().catch(() => {});
    llamaInstance = undefined;
  }

  resolvedPaths.clear();
}
