/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { PermanentJobError } from "@workglow/job-queue";
import type { StreamPhase } from "@workglow/task-graph";
import {
  loadTfmpTasksAudioSDK,
  loadTfmpTasksGenaiSDK,
  loadTfmpTasksTextSDK,
  loadTfmpTasksVisionSDK,
} from "./TFMP_Client";
import type { TfmpDelegate } from "./TFMP_Delegate";
import { resolveTfmpDelegate } from "./TFMP_Delegate";
import type { TFMPModelConfig } from "./TFMP_ModelSchema";

export interface TFMPWasmFileset {
  readonly wasmLoaderPath: string;
  readonly wasmBinaryPath: string;
  readonly assetLoaderPath?: string;
  readonly assetBinaryPath?: string;
}

export const wasm_tasks = new Map<string, TFMPWasmFileset>();
export const wasm_reference_counts = new Map<string, number>();

export interface ITFMPWasmBaseUrls {
  readonly vision: string;
  readonly text: string;
  readonly audio: string;
  readonly genai: string;
}

/**
 * The installed `@mediapipe/tasks-*` version per engine, defined by `build.ts`
 * when the package is bundled. The WASM must match the bundled JS SDK — the
 * JS↔WASM ABI is not stable across versions — and CSP `script-src` cannot pin
 * a version, so an unversioned URL would run whatever npm's dist-tag points at.
 *
 * Undefined when the source runs unbundled (tests, `use-source`); the URLs
 * then fall back to the unversioned path, i.e. the latest release.
 */
declare const __TFMP_WASM_VERSIONS__: ITFMPWasmBaseUrls | undefined;

const WASM_VERSIONS =
  typeof __TFMP_WASM_VERSIONS__ === "undefined" ? undefined : __TFMP_WASM_VERSIONS__;

function jsDelivrWasmUrl(sdk: string, version: string | undefined): string {
  const pinned = version === undefined ? sdk : `${sdk}@${version}`;
  return `https://cdn.jsdelivr.net/npm/@mediapipe/${pinned}/wasm`;
}

const DEFAULT_WASM_BASE_URLS: ITFMPWasmBaseUrls = {
  vision: jsDelivrWasmUrl("tasks-vision", WASM_VERSIONS?.vision),
  text: jsDelivrWasmUrl("tasks-text", WASM_VERSIONS?.text),
  audio: jsDelivrWasmUrl("tasks-audio", WASM_VERSIONS?.audio),
  genai: jsDelivrWasmUrl("tasks-genai", WASM_VERSIONS?.genai),
};

let currentWasmBaseUrls: ITFMPWasmBaseUrls = DEFAULT_WASM_BASE_URLS;

/**
 * Applies `next`, dropping any {@link wasm_tasks} fileset that was resolved
 * from a base URL the change replaces. `getWasmTask` memoizes per engine and
 * never consults the URL again, so without this an override applied after the
 * first MediaPipe use would be silently ignored.
 *
 * Only the fileset descriptor is dropped; already-created task instances (and
 * their `wasm_reference_counts` entries) keep the fileset they were built with
 * and are unaffected.
 */
function applyWasmBaseUrls(next: ITFMPWasmBaseUrls): void {
  for (const engine of Object.keys(next) as (keyof ITFMPWasmBaseUrls)[]) {
    if (next[engine] !== currentWasmBaseUrls[engine]) {
      wasm_tasks.delete(engine);
    }
  }
  currentWasmBaseUrls = next;
}

/**
 * Point the FilesetResolver at caller-supplied base URLs — typically same-origin
 * paths (`/wasm/{engine}`) after the host app has vendored MediaPipe's `wasm/`
 * directories into its static assets. Overrides are per-engine; engines that
 * are absent (or explicitly `undefined`) keep the current value (initially the
 * pinned jsDelivr URLs).
 *
 * Host apps that vendor MediaPipe's WASM should then drop `cdn.jsdelivr.net`
 * from their CSP; the pinned defaults exist only so the module remains usable
 * without any host-side wiring.
 *
 * The override is module-level state, so it must be applied in **every** realm
 * *and every bundle* that resolves filesets. Always import it from
 * `@workglow/tf-mediapipe/ai-runtime` — the `./ai` and `./ai-runtime` entry
 * points are bundled separately with no shared chunk, so each holds its own
 * copy of this state and only the `./ai-runtime` copy is the one
 * `getWasmTask` reads. Apply it on the main thread before
 * `registerTensorFlowMediaPipeInline`, and again in the worker's own bootstrap
 * before `registerTensorFlowMediaPipeWorker` — a main-thread call does not
 * reach the worker.
 */
export function setTfmpWasmBaseUrls(bases: Partial<ITFMPWasmBaseUrls>): void {
  const next = { ...currentWasmBaseUrls };
  for (const [engine, override] of Object.entries(bases) as [
    keyof ITFMPWasmBaseUrls,
    string | undefined,
  ][]) {
    if (override !== undefined) next[engine] = override;
  }
  applyWasmBaseUrls(next);
}

export function getTfmpWasmBaseUrls(): ITFMPWasmBaseUrls {
  return currentWasmBaseUrls;
}

export function resetTfmpWasmBaseUrls(): void {
  applyWasmBaseUrls(DEFAULT_WASM_BASE_URLS);
}

type TaskConstructor = {
  createFromOptions(
    wasmFileset: TFMPWasmFileset,
    options: Record<string, unknown>
  ): Promise<TaskInstance>;
};

export type TaskInstance = {
  close(): void;
  [key: string]: any;
};

export interface CachedModelTask {
  readonly task: TaskInstance;
  readonly options: Record<string, unknown>;
  readonly task_engine: string;
}

export const modelTaskCache = new Map<string, CachedModelTask[]>();

const valuesMatch = (val1: unknown, val2: unknown): boolean => {
  if (val1 === val2) return true;
  if (val1 && val2 && typeof val1 === "object" && typeof val2 === "object") {
    return JSON.stringify(val1) === JSON.stringify(val2);
  }
  return false;
};

export const optionsMatch = (
  opts1: Record<string, unknown>,
  opts2: Record<string, unknown>
): boolean => {
  const keys1 = Object.keys(opts1).sort();
  const keys2 = Object.keys(opts2).sort();

  if (keys1.length !== keys2.length) return false;
  if (!keys1.every((key, i) => key === keys2[i])) return false;

  return keys1.every((key) => valuesMatch(opts1[key], opts2[key]));
};

export const getWasmTask = async (
  model: TFMPModelConfig,
  emit: (event: StreamPhase) => void,
  signal: AbortSignal
): Promise<TFMPWasmFileset> => {
  const task_engine = model.provider_config.task_engine;

  if (wasm_tasks.has(task_engine)) {
    return wasm_tasks.get(task_engine)!;
  }

  if (signal.aborted) {
    throw new PermanentJobError("Aborted job");
  }

  emit({ type: "phase", message: "Loading WASM task", progress: 0.1 });

  let wasmFileset: TFMPWasmFileset;

  switch (task_engine) {
    case "vision": {
      const { FilesetResolver } = await loadTfmpTasksVisionSDK();
      wasmFileset = await FilesetResolver.forVisionTasks(currentWasmBaseUrls.vision);
      break;
    }
    case "text": {
      const { FilesetResolver } = await loadTfmpTasksTextSDK();
      wasmFileset = await FilesetResolver.forTextTasks(currentWasmBaseUrls.text);
      break;
    }
    case "audio": {
      const { FilesetResolver } = await loadTfmpTasksAudioSDK();
      wasmFileset = await FilesetResolver.forAudioTasks(currentWasmBaseUrls.audio);
      break;
    }
    case "genai": {
      const { FilesetResolver } = await loadTfmpTasksGenaiSDK();
      wasmFileset = await FilesetResolver.forGenAiTasks(currentWasmBaseUrls.genai);
      break;
    }
    default:
      throw new PermanentJobError("Invalid task engine");
  }

  wasm_tasks.set(task_engine, wasmFileset);
  return wasmFileset;
};

export const getModelTask = async (
  model: TFMPModelConfig,
  options: Record<string, unknown>,
  emit: (event: StreamPhase) => void,
  signal: AbortSignal,
  TaskType: TaskConstructor
): Promise<any> => {
  const model_path = model.provider_config.model_path;
  const task_engine = model.provider_config.task_engine;
  const gpu = (model.provider_config as { gpu?: boolean }).gpu;

  const { baseOptions: rawCallerBase, ...rest } = options;
  const callerBase = (rawCallerBase as Record<string, unknown> | undefined) ?? {};

  // An explicit caller delegate wins over the model-level gpu flag.
  const delegate =
    (callerBase.delegate as TfmpDelegate | undefined) ?? resolveTfmpDelegate(task_engine, gpu);

  const buildOptions = (del: TfmpDelegate | undefined): Record<string, unknown> => ({
    ...rest,
    baseOptions: {
      ...callerBase,
      ...(del ? { delegate: del } : {}),
      modelAssetPath: model_path,
    },
  });

  const lookupOptions = buildOptions(delegate);

  const cachedTasks = modelTaskCache.get(model_path);
  if (cachedTasks) {
    const matchedTask = cachedTasks.find((cached) => optionsMatch(cached.options, lookupOptions));
    if (matchedTask) {
      return matchedTask.task;
    }
  }

  const wasmFileset = await getWasmTask(model, emit, signal);

  emit({ type: "phase", message: "Creating model task", progress: 0.2 });

  let task: TaskInstance;
  try {
    task = await TaskType.createFromOptions(wasmFileset, lookupOptions);
  } catch (error) {
    if (delegate !== "GPU") throw error;
    // Some contexts (headless, missing WebGL2) cannot create GPU-delegate
    // tasks; retry once on CPU rather than failing the model outright.
    emit({
      type: "phase",
      message: "GPU delegate unavailable, falling back to CPU",
      progress: 0.2,
    });
    task = await TaskType.createFromOptions(wasmFileset, buildOptions("CPU"));
  }

  // Cache under the *requested* options so the next identical request hits
  // even when creation fell back to CPU.
  const cachedTask: CachedModelTask = { task, options: lookupOptions, task_engine };
  if (!modelTaskCache.has(model_path)) {
    modelTaskCache.set(model_path, []);
  }
  modelTaskCache.get(model_path)!.push(cachedTask);

  wasm_reference_counts.set(task_engine, (wasm_reference_counts.get(task_engine) || 0) + 1);

  return task;
};
