/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LlmInference } from "@mediapipe/tasks-genai";
import { PermanentJobError } from "@workglow/job-queue";
import type { StreamPhase } from "@workglow/task-graph";
import { loadTfmpTasksGenaiSDK } from "./TFMP_Client";
import type { TFMPModelConfig } from "./TFMP_ModelSchema";
import type { TaskInstance } from "./TFMP_Runtime";
import { getWasmTask, modelTaskCache, wasm_reference_counts, wasm_tasks } from "./TFMP_Runtime";

interface GenaiProviderConfig {
  readonly model_path: string;
  readonly max_tokens?: number;
  readonly top_k?: number;
  readonly temperature?: number;
  readonly random_seed?: number;
}

/** Per-model promise chain: the SDK allows one generateResponse at a time per instance. */
const genaiLocks = new Map<string, Promise<unknown>>();

/** In-flight creations: single-flight per model path (cleared when settled). */
const genaiCreations = new Map<string, Promise<LlmInference>>();

let _webGpuDevicePromise: Promise<unknown> | undefined;

function webGpuUnavailableError(): PermanentJobError {
  return new PermanentJobError(
    "MediaPipe LLM inference requires WebGPU, which is not available in this context. " +
      "Use a WebGPU-enabled browser (e.g. Chrome 113+) and ensure WebGPU is exposed to this window/worker."
  );
}

/**
 * Create (once) the shared high-performance WebGPU device used by every
 * LlmInference instance in this runtime.
 */
async function getWebGpuDevice(): Promise<unknown> {
  if (typeof navigator === "undefined" || !(navigator as { gpu?: unknown }).gpu) {
    throw webGpuUnavailableError();
  }
  if (!_webGpuDevicePromise) {
    _webGpuDevicePromise = (async () => {
      const { LlmInference: LlmInferenceClass } = await loadTfmpTasksGenaiSDK();
      try {
        return await LlmInferenceClass.createWebGpuDevice();
      } catch (error) {
        _webGpuDevicePromise = undefined;
        const message = error instanceof Error ? error.message : String(error);
        throw new PermanentJobError(
          `Failed to create a WebGPU device for MediaPipe LLM inference: ${message}`
        );
      }
    })();
  }
  return _webGpuDevicePromise;
}

/** Serialize all SDK calls against one model's LlmInference instance. */
export async function withGenaiLock<T>(model_path: string, fn: () => Promise<T>): Promise<T> {
  const prev = genaiLocks.get(model_path) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  genaiLocks.set(model_path, next);
  try {
    return await next;
  } finally {
    if (genaiLocks.get(model_path) === next) {
      genaiLocks.delete(model_path);
    }
  }
}

/** True when a run currently holds (or is queued on) the model's lock. */
export function isGenaiBusy(model_path: string): boolean {
  return genaiLocks.has(model_path);
}

function findCachedGenai(model_path: string): LlmInference | undefined {
  const entries = modelTaskCache.get(model_path);
  const entry = entries?.find((cached) => cached.task_engine === "genai");
  return entry?.task as LlmInference | undefined;
}

/** Return the cached LlmInference for a model, or undefined when not loaded. */
export function peekGenaiLlm(model: TFMPModelConfig): LlmInference | undefined {
  return findCachedGenai(model.provider_config.model_path);
}

/**
 * Get (or create) the single LlmInference instance for a model. Creation
 * options come from `provider_config` only — the web SDK cannot change sampler
 * options after load, so there are no per-run overrides. The instance registers
 * into the shared modelTaskCache, so `model.download-remove` (TFMP_Unload) and
 * `model.info` (is_loaded) work unchanged. Concurrent cold starts share one
 * creation instead of loading the multi-GB model twice.
 */
export async function getGenaiLlm(
  model: TFMPModelConfig,
  emit: (event: StreamPhase) => void,
  signal: AbortSignal
): Promise<LlmInference> {
  const model_path = model.provider_config.model_path;

  const cached = findCachedGenai(model_path);
  if (cached) return cached;

  const inFlight = genaiCreations.get(model_path);
  if (inFlight) return inFlight;

  const creation = createGenaiLlm(model, emit, signal);
  genaiCreations.set(model_path, creation);
  try {
    return await creation;
  } finally {
    genaiCreations.delete(model_path);
  }
}

async function createGenaiLlm(
  model: TFMPModelConfig,
  emit: (event: StreamPhase) => void,
  signal: AbortSignal
): Promise<LlmInference> {
  const model_path = model.provider_config.model_path;

  if (signal.aborted) {
    throw new PermanentJobError("Aborted job");
  }

  const device = await getWebGpuDevice();
  const wasmFileset = await getWasmTask(model, emit, signal);

  emit({ type: "phase", message: "Creating model task", progress: 0.2 });

  const { LlmInference: LlmInferenceClass } = await loadTfmpTasksGenaiSDK();
  const pc = model.provider_config as GenaiProviderConfig;

  let llm: LlmInference;
  try {
    llm = await LlmInferenceClass.createFromOptions(wasmFileset, {
      baseOptions: {
        modelAssetPath: model_path,
        gpuOptions: { device: device as never },
      },
      ...(pc.max_tokens !== undefined ? { maxTokens: pc.max_tokens } : {}),
      ...(pc.top_k !== undefined ? { topK: pc.top_k } : {}),
      ...(pc.temperature !== undefined ? { temperature: pc.temperature } : {}),
      ...(pc.random_seed !== undefined ? { randomSeed: pc.random_seed } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PermanentJobError(`Failed to load MediaPipe LLM model: ${message}`);
  }

  if (!modelTaskCache.has(model_path)) {
    modelTaskCache.set(model_path, []);
  }
  modelTaskCache
    .get(model_path)!
    .push({ task: llm as unknown as TaskInstance, options: {}, task_engine: "genai" });
  wasm_reference_counts.set("genai", (wasm_reference_counts.get("genai") || 0) + 1);

  return llm;
}

/**
 * Close and uncache every genai instance for a model under the per-model
 * lock, so an in-flight generateResponse/sizeInTokens finishes first. Must
 * NOT be called from inside a withGenaiLock closure (it takes the lock).
 */
export async function closeGenaiLlm(model_path: string): Promise<void> {
  await withGenaiLock(model_path, async () => {
    const entries = modelTaskCache.get(model_path);
    if (!entries) return;
    const remaining = entries.filter((cached) => {
      if (cached.task_engine !== "genai") return true;
      try {
        cached.task.close();
      } catch {
        // already closed
      }
      const newCount = (wasm_reference_counts.get("genai") ?? 1) - 1;
      if (newCount <= 0) {
        wasm_tasks.delete("genai");
        wasm_reference_counts.delete("genai");
      } else {
        wasm_reference_counts.set("genai", newCount);
      }
      return false;
    });
    if (remaining.length > 0) {
      modelTaskCache.set(model_path, remaining);
    } else {
      modelTaskCache.delete(model_path);
    }
  });
}

/**
 * Run one streaming generation. The SDK's progressListener receives newly
 * generated partial text (a delta); abort maps to cancelProcessing(), and any
 * cancel signal is cleared afterwards where the SDK supports it. Call under
 * {@link withGenaiLock}.
 */
export async function generateGenaiResponse(
  llm: LlmInference,
  prompt: string,
  signal: AbortSignal,
  onDelta: ((text: string) => void) | undefined
): Promise<string> {
  if (signal.aborted) {
    throw new PermanentJobError("Aborted job");
  }
  const onAbort = () => {
    try {
      llm.cancelProcessing();
    } catch {
      // instance may already be closed
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await llm.generateResponse(prompt, (partialResult: string, _done: boolean) => {
      if (partialResult && onDelta) onDelta(partialResult);
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
    // 0.10.29 and 0.10.30 ship without clearCancelSignals (declared in the d.ts but not
    // exported from the bundle); the SDK also self-resets its cancel flag at
    // the start of each generation, so this is a best-effort call for newer SDKs.
    const clear = (llm as { clearCancelSignals?: () => void }).clearCancelSignals;
    if (typeof clear === "function") {
      try {
        clear.call(llm);
      } catch {
        // instance may already be closed
      }
    }
  }
}
