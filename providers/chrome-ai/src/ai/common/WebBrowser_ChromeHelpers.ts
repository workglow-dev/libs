/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { PermanentJobError } from "@workglow/job-queue";
import type { StreamEvent } from "@workglow/task-graph";
import {
  isWebBrowserModelCached,
  resolveWebBrowserApi,
  type WebBrowserApiBinding,
} from "./WebBrowser_ApiBinding";
import type { WebBrowserModelConfig } from "./WebBrowser_ModelSchema";

// Chrome built-in AI globals (`LanguageModel`, `Summarizer`, etc.) and their
// option types are declared by `@types/dom-chromium-ai`, which is loaded
// transitively as a devDependency and surfaces as ambient global types.

export { isWebBrowserModelCached, resolveWebBrowserApi } from "./WebBrowser_ApiBinding";

export interface ProviderConfig {
  readonly pipeline?: string;
  readonly summary_type?: SummarizerType;
  readonly summary_length?: SummarizerLength;
  readonly summary_format?: SummarizerFormat;
  readonly rewriter_tone?: RewriterTone;
  readonly rewriter_length?: RewriterLength;
}

export function getConfig(model: WebBrowserModelConfig | undefined): ProviderConfig {
  return (model?.provider_config ?? {}) as ProviderConfig;
}

export function getApi<T>(name: string, global: T | undefined): T {
  if (!global) {
    throw new PermanentJobError(
      `Chrome Built-in AI "${name}" API is not available in this browser.`
    );
  }
  return global;
}

export function getChromeGlobal<T = unknown>(name: string): T | undefined {
  return (globalThis as unknown as Record<string, T | undefined>)[name];
}

export function assertAvailability(name: string, status: Availability): void {
  if (status === "unavailable") {
    throw new PermanentJobError(
      `Chrome Built-in AI "${name}" is not available (status: "no"). ` +
        `Ensure you are using a compatible Chrome version with the flag enabled.`
    );
  }
}

export async function ensureAvailable(
  name: string,
  factory: { availability(options?: never): Promise<Availability> },
  options?: unknown
): Promise<Availability> {
  const status = await factory.availability(options as never);
  assertAvailability(name, status);
  return status;
}

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`
  );
  return `{${entries.join(",")}}`;
}

/**
 * Throttle (ms) between `phase` progress events emitted from a
 * `downloadprogress` listener. Chrome can fire this listener at very high
 * frequency; we cap upstream traffic without dropping the first/last frames.
 */
const PROGRESS_THROTTLE_MS = 100;

/**
 * Returns a `monitor` callback for any Chrome built-in AI `create()` call
 * that forwards `downloadprogress` events as `phase` stream events.
 *
 * The `loaded` field on the event is a fraction in `[0, 1]`. We map it to a
 * 0–100 percentage and emit `{ type: "phase", message, progress }`. The
 * first event and the final 100% event are always emitted; intermediate
 * events are throttled to {@link PROGRESS_THROTTLE_MS}.
 *
 * @see https://developer.chrome.com/docs/ai/prompt-api#download-progress
 */
export function createDownloadMonitor<Output>(
  emit: (event: StreamEvent<Output>) => void,
  message: string = "Downloading model"
): CreateMonitorCallback {
  return (m) => {
    let lastEmit = 0;
    let pending: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const send = (progress: number): void => {
      emit({ type: "phase", message, progress } as StreamEvent<Output>);
      lastEmit = Date.now();
      pending = null;
    };

    m.addEventListener("downloadprogress", (e) => {
      const fraction = typeof e.loaded === "number" ? e.loaded : 0;
      const progress = Math.max(0, Math.min(100, Math.round(fraction * 100)));
      const now = Date.now();
      const isFirst = lastEmit === 0;
      const isFinal = progress >= 100;

      if (isFirst || isFinal) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        send(progress);
        return;
      }

      if (now - lastEmit < PROGRESS_THROTTLE_MS) {
        pending = progress;
        if (!timer) {
          const wait = Math.max(1, PROGRESS_THROTTLE_MS - (now - lastEmit));
          timer = setTimeout(() => {
            timer = null;
            if (pending !== null) send(pending);
          }, wait);
        }
        return;
      }

      send(progress);
    });
  };
}

type PhaseEmit = (event: { type: "phase"; message: string; progress: number | undefined }) => void;

export async function queryWebBrowserAvailability(
  binding: WebBrowserApiBinding
): Promise<Availability> {
  try {
    switch (binding.apiName) {
      case "Summarizer":
        return await binding.factory.availability(binding.availabilityOptions);
      case "Rewriter":
        return await binding.factory.availability(binding.availabilityOptions);
      case "Translator":
        return await binding.factory.availability(binding.availabilityOptions);
      case "LanguageDetector":
        return await binding.factory.availability(binding.availabilityOptions);
      case "LanguageModel":
        return await binding.factory.availability(binding.availabilityOptions);
    }
  } catch {
    return "unavailable";
  }
}

const phaseDownloadMonitor =
  (apiName: string, emit: PhaseEmit): CreateMonitorCallback =>
  (monitor) => {
    monitor.addEventListener("downloadprogress", (event: ProgressEvent) => {
      const pct = Math.round(event.loaded * 100);
      if (event.loaded >= 1) {
        emit({
          type: "phase",
          message: "Extracting and loading model...",
          progress: undefined,
        });
      } else {
        emit({
          type: "phase",
          message: `Downloading ${apiName} model...`,
          progress: pct,
        });
      }
    });
  };

async function createForDownload(
  binding: WebBrowserApiBinding,
  signal: AbortSignal | undefined,
  emit: PhaseEmit
): Promise<DestroyableModel> {
  const monitor = phaseDownloadMonitor(binding.apiName, emit);
  switch (binding.apiName) {
    case "Summarizer":
      return binding.factory.create({ ...binding.createOptions, signal, monitor });
    case "Rewriter":
      return binding.factory.create({ ...binding.createOptions, signal, monitor });
    case "Translator":
      return binding.factory.create({ ...binding.createOptions, signal, monitor });
    case "LanguageDetector":
      return binding.factory.create({ ...binding.createOptions, signal, monitor });
    case "LanguageModel":
      return binding.factory.create({ ...binding.createOptions, signal, monitor });
  }
}

/**
 * Ensures the Chrome Built-in AI model for `binding` is downloaded and loaded.
 * Emits `phase` events with 0–100 progress from the browser `downloadprogress` monitor.
 */
export async function downloadWebBrowserModel(
  binding: WebBrowserApiBinding,
  signal: AbortSignal | undefined,
  emit: PhaseEmit
): Promise<void> {
  emit({ type: "phase", message: "Checking Chrome availability...", progress: 0 });

  const status = await queryWebBrowserAvailability(binding);
  if (status === "unavailable") {
    throw new PermanentJobError(
      `Chrome Built-in AI "${binding.apiName}" is not available on this device.`
    );
  }
  if (isWebBrowserModelCached(status)) {
    emit({ type: "phase", message: "Already on this device", progress: 100 });
    return;
  }

  if (status === "downloading") {
    emit({
      type: "phase",
      message: "Chrome is downloading the model — resuming...",
      progress: undefined,
    });
  } else {
    emit({ type: "phase", message: "Starting download...", progress: 0 });
  }

  const session = await createForDownload(binding, signal, emit);
  session.destroy();
  emit({ type: "phase", message: "Download complete", progress: 100 });
}

export async function queryWebBrowserModelStatus(
  model: WebBrowserModelConfig | undefined
): Promise<{
  readonly availability: Availability;
  readonly is_cached: boolean;
  readonly is_loaded: boolean;
}> {
  const binding = resolveWebBrowserApi(model);
  const availability = await queryWebBrowserAvailability(binding);
  const ready = isWebBrowserModelCached(availability);
  return { availability, is_cached: ready, is_loaded: ready };
}

/**
 * Chrome streaming APIs return progressive full-text snapshots. This helper
 * converts them to append-mode `text-delta` events by diffing successive
 * snapshots and forwarding each delta to `emit`.
 *
 * **Reset semantics**: most snapshots are prefix-extensions of the previous
 * one (the model is appending). When a snapshot is NOT a prefix extension
 * (a self-correction: Chrome replaced rather than extended prior text), the
 * accumulator is RESET to the new snapshot and the full new snapshot is
 * emitted as a single delta. Consumers that reconstruct full text by
 * concatenating successive deltas should treat a non-prefix delta as a
 * reset boundary; use {@link snapshotStreamToSnapshots} if you need
 * explicit replace-mode events.
 *
 * Identical consecutive snapshots emit no delta. The caller is responsible
 * for emitting its own `finish` event after this returns — this helper
 * never emits `finish`. Resolves to the last snapshot, the text the call
 * ended with, which is what a caller estimating its output size counts.
 */
export async function snapshotStreamToTextDeltas<Output>(
  stream: ReadableStream<string>,
  port: string,
  emit: (event: StreamEvent<Output>) => void
): Promise<string> {
  const reader = stream.getReader();
  let accumulatedText = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.startsWith(accumulatedText)) {
        const delta = value.slice(accumulatedText.length);
        accumulatedText = value;
        if (delta) {
          emit({ type: "text-delta", port, textDelta: delta });
        }
      } else {
        // Self-correction snapshot: Chrome replaced (not extended) prior text.
        // Reset the accumulator and surface the full new snapshot as the
        // delta. Consumers reconstructing full text by concatenation should
        // treat any subsequent non-prefix delta as a reset boundary; use
        // `snapshotStreamToSnapshots` if you need replace-mode semantics.
        accumulatedText = value;
        emit({ type: "text-delta", port, textDelta: value });
      }
    }
  } finally {
    reader.releaseLock();
  }
  return accumulatedText;
}

/**
 * Chrome streaming APIs return progressive full-text snapshots. Forwards
 * each snapshot as a replace-mode `snapshot` event via `emit`. The caller
 * is responsible for emitting its own `finish` event after this returns.
 */
export async function snapshotStreamToSnapshots<Output>(
  stream: ReadableStream<string>,
  buildOutput: (text: string) => Output,
  emit: (event: StreamEvent<Output>) => void
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      emit({ type: "snapshot", data: buildOutput(value) });
    }
  } finally {
    reader.releaseLock();
  }
}
