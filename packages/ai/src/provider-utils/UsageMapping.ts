/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StreamUsage, Usage } from "@workglow/task-graph";
import { USAGE_COUNTER_FIELDS } from "@workglow/task-graph";
import { getLogger } from "@workglow/util";

/**
 * Shared normalization from a provider's own token-accounting payload into the
 * provider-agnostic {@link Usage} shape.
 *
 * The governing rule is that `undefined` means **the provider did not report
 * this figure**, never "zero". A wire field that is absent, `null`, `NaN`, or
 * not a number stays `undefined` so downstream cost math can tell "billed
 * nothing" apart from "told us nothing"; only a real reported `0` becomes `0`.
 *
 * Usage is always read from the provider's own terminal frame — never derived
 * by counting emitted output, which would drift from what the provider bills.
 */

/**
 * Coerce one wire field to a usage counter. Anything that is not a finite
 * number — absent, `null`, a string, `NaN` — is "not reported".
 */
export function toUsageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Collapse a fully-unreported {@link Usage} to `undefined`. A provider that
 * sent a usage object carrying nothing recognizable reported nothing, and
 * should be indistinguishable from one that sent no usage object at all.
 */
export function usageOrUndefined(usage: Usage): Usage | undefined {
  const reported =
    USAGE_COUNTER_FIELDS.some((field) => usage[field] !== undefined) || usage.extra !== undefined;
  return reported ? usage : undefined;
}

/**
 * Build the `extra` bag from provider-specific counters, dropping unreported
 * ones. Returns `undefined` when nothing survives, so `extra` is absent rather
 * than an empty object.
 */
export function usageExtra(
  entries: Readonly<Record<string, number | string | undefined>>
): Readonly<Record<string, number | string>> | undefined {
  const extra: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) extra[key] = value;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/**
 * Normalize a provider that reports the whole prompt plus a breakdown line into
 * the disjoint `input` bucket: the portion billed at the base input rate.
 *
 * Subtracts only the breakdown counters the provider actually stated, so an
 * unreported one leaves `input` as the stated prompt total rather than guessing.
 * A negative result means the provider contradicted itself (`cached > prompt`,
 * which its own API defines as impossible), so it clamps to 0 and warns — that
 * is a contract violation worth surfacing, not absorbing.
 */
function disjointInput(
  provider: string,
  prompt: number | undefined,
  ...breakdown: readonly (number | undefined)[]
): number | undefined {
  if (prompt === undefined) return undefined;
  const subtracted = breakdown.reduce<number>((acc, part) => acc + (part ?? 0), 0);
  const remainder = prompt - subtracted;
  if (remainder < 0) {
    getLogger().warn(
      `${provider} reported cache counters exceeding its prompt total; clamping input to 0`,
      { prompt, subtracted }
    );
    return 0;
  }
  return remainder;
}

/** Raw usage payload on an OpenAI-compatible chat-completions terminal chunk. */
interface OpenAIChatUsagePayload {
  readonly prompt_tokens?: unknown;
  readonly completion_tokens?: unknown;
  readonly total_tokens?: unknown;
  readonly prompt_tokens_details?: { readonly cached_tokens?: unknown } | null;
  readonly completion_tokens_details?: { readonly reasoning_tokens?: unknown } | null;
}

/**
 * Map an OpenAI-compatible chat-completions `usage` object (xAI, DeepSeek,
 * OpenRouter, llama.cpp server, Hugging Face Inference) into {@link Usage}.
 *
 * Chat completions only emit this object when the request asked for it with
 * `stream_options: { include_usage: true }`, and it arrives on a final chunk
 * whose `choices` array is **empty** — so a delta loop must read usage before
 * it skips a choice-less chunk.
 *
 * Providers reporting counters beyond this common set layer their own on top
 * (see {@link usageExtra}).
 */
export function mapOpenAIChatUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const payload = raw as OpenAIChatUsagePayload;
  return usageOrUndefined({
    input: disjointInput(
      "OpenAI-compatible chat completions",
      toUsageCount(payload.prompt_tokens),
      toUsageCount(payload.prompt_tokens_details?.cached_tokens)
    ),
    output: toUsageCount(payload.completion_tokens),
    cached: toUsageCount(payload.prompt_tokens_details?.cached_tokens),
    cacheWrite: undefined,
    reasoning: toUsageCount(payload.completion_tokens_details?.reasoning_tokens),
    total: toUsageCount(payload.total_tokens),
    extra: undefined,
  });
}

/** Raw usage payload on an OpenAI **Responses** `response.completed` event. */
interface OpenAIResponsesUsagePayload {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly total_tokens?: unknown;
  readonly input_tokens_details?: {
    readonly cached_tokens?: unknown;
    readonly cache_write_tokens?: unknown;
  } | null;
  readonly output_tokens_details?: { readonly reasoning_tokens?: unknown } | null;
}

/**
 * Map an OpenAI **Responses** API `usage` object into {@link Usage}. The
 * Responses shape names its fields differently from chat completions
 * (`input_tokens` rather than `prompt_tokens`) and nests cache reads/writes
 * under `input_tokens_details`.
 *
 * Both nested counters are portions **of** `input_tokens`, not additions to it,
 * which is what makes subtracting them the right way to recover the base-rate
 * bucket. Measured against the live API: a cold call reports
 * `input_tokens: 11239, cache_write_tokens: 11236`, and the warm call that
 * follows reports the same `input_tokens: 11239` with `cached_tokens: 11236` —
 * the counters move while the prompt total does not, and `total_tokens` stays
 * `input_tokens + output_tokens` throughout. Were they siblings, subtracting
 * would under-report the prompt by the size of the cache hit on every cached
 * call.
 */
export function mapOpenAIResponsesUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const payload = raw as OpenAIResponsesUsagePayload;
  return usageOrUndefined({
    input: disjointInput(
      "OpenAI Responses",
      toUsageCount(payload.input_tokens),
      toUsageCount(payload.input_tokens_details?.cached_tokens),
      toUsageCount(payload.input_tokens_details?.cache_write_tokens)
    ),
    output: toUsageCount(payload.output_tokens),
    cached: toUsageCount(payload.input_tokens_details?.cached_tokens),
    cacheWrite: toUsageCount(payload.input_tokens_details?.cache_write_tokens),
    reasoning: toUsageCount(payload.output_tokens_details?.reasoning_tokens),
    total: toUsageCount(payload.total_tokens),
    extra: undefined,
  });
}

/** Raw usage payload on an OpenAI **Images** response or terminal stream event. */
interface OpenAIImageUsagePayload {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly total_tokens?: unknown;
  readonly input_tokens_details?: {
    readonly text_tokens?: unknown;
    readonly image_tokens?: unknown;
  } | null;
}

/**
 * Map an OpenAI **Images** API `usage` object into {@link Usage}: the one
 * `images.generate` / `images.edit` return, and the one the terminal
 * `image_generation.completed` / `image_edit.completed` stream event carries.
 *
 * This is the only OpenAI surface that splits the prompt by modality, and GPT
 * Image is the only OpenAI card that prices the halves apart — text input at
 * $5/1M against image input at $8/1M — which is why it is the only mapper that
 * fills `imageInput`. On the chat and Responses surfaces an image in the prompt
 * is billed at the model's ordinary input rate, so its tokens belong in `input`;
 * splitting them out there would move spend into a bucket those cards declare no
 * rate for and turn an exact estimate into a partial one.
 *
 * `input_tokens_details` splits `input_tokens` disjointly into `text_tokens` and
 * `image_tokens`, so the stated text figure becomes `input` directly and is
 * recovered by subtraction only when the provider omits it.
 *
 * The payload carries no cache counters — neither a total nor a per-modality
 * breakdown — so `cached`, `cacheWrite` and `imageCached` stay unreported. That
 * is the wire's own silence, not a normalization choice: no OpenAI surface
 * states a cached figure per modality, so a cached image cannot be told from a
 * cached word on any of them.
 */
export function mapOpenAIImageUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const payload = raw as OpenAIImageUsagePayload;
  const imageInput = toUsageCount(payload.input_tokens_details?.image_tokens);
  const textInput = toUsageCount(payload.input_tokens_details?.text_tokens);
  return usageOrUndefined({
    input:
      textInput ?? disjointInput("OpenAI Images", toUsageCount(payload.input_tokens), imageInput),
    output: toUsageCount(payload.output_tokens),
    cached: undefined,
    cacheWrite: undefined,
    ...(imageInput !== undefined ? { imageInput } : {}),
    reasoning: undefined,
    total: toUsageCount(payload.total_tokens),
    extra: undefined,
  });
}

/**
 * Request fragment that turns on usage reporting for an OpenAI-compatible
 * streaming chat completion. Spread into the request body by every provider on
 * that shape — without it the stream carries no usage at all.
 */
export const OPENAI_STREAM_USAGE_OPTIONS = {
  stream_options: { include_usage: true },
} as const;

/**
 * Wrap a run-fn's `emit` so cumulative usage can be reported mid-stream without
 * flooding the consumer.
 *
 * Call the returned function with the collector's current result after each
 * provider frame. It emits only when a counter actually moved, which matters for
 * providers that restate cumulative usage on every chunk — without the gate a
 * long generation would emit one event per token.
 *
 * What it emits is a **cumulative snapshot of the current call**, never a delta:
 * consumers replace their in-flight value rather than accumulating, so a dropped
 * event costs nothing and a repeated one double-counts nothing.
 */
export function createUsageSnapshotEmitter(
  emit: (event: StreamUsage) => void
): (usage: Usage | undefined) => void {
  let last: Usage | undefined;
  return (usage: Usage | undefined): void => {
    if (!usage) return;
    if (last && !usageChanged(last, usage)) return;
    last = usage;
    emit({ type: "usage", usage });
  };
}

/** How often {@link createEstimatedOutputUsageReporter} may emit, in milliseconds. */
const ESTIMATED_USAGE_INTERVAL_MS = 250;

/**
 * Approximate characters per token for OpenAI-shaped streams that only report
 * billed usage on the terminal chunk (OpenRouter, DeepSeek, xAI, Ollama, HF
 * Inference, OpenAI Responses). Matches the heuristic in those providers'
 * `count-tokens` run-fns — good enough for a live ↑↓ counter, not for billing.
 */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Heuristic token estimate used for provisional mid-stream usage and for
 * providers with no dedicated count endpoint (`ceil(chars / 4)`).
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/** Reports provisional prompt + output token spend for OpenAI-shaped streams. */
export interface EstimatedOutputUsageReporter {
  /**
   * The request prompt is known: estimate its size and emit ↑ immediately
   * (output still 0), mirroring a local model's `onPrompt`.
   */
  readonly onPrompt: (text: string) => void;
  /** A content delta arrived; grow the provisional output count. */
  readonly onText: (text: string) => void;
  /** Emit the final estimate, ignoring the throttle. */
  readonly flush: () => void;
}

/**
 * Emit provisional mid-stream {@link Usage} snapshots for providers whose API
 * only attaches billed usage to the **final** chunk (OpenAI-compatible chat
 * completions with `include_usage`).
 *
 * Anthropic / Gemini restate cumulative usage throughout the stream, and local
 * models count real decode tokens — those paths use
 * {@link createUsageSnapshotEmitter} / a decode reporter. Chat-completions
 * shape has nothing until the empty-choices trailer, so without this the CLI
 * row stays on a static "Generating" with no ↑↓ for the whole call.
 *
 * Call {@link EstimatedOutputUsageReporter.onPrompt} with the request text as
 * soon as the stream is opened so ↑ appears before the first delta (same
 * moment a local model can state its prompt cost). Then feed content deltas to
 * {@link EstimatedOutputUsageReporter.onText}. Estimates use
 * {@link estimateTokenCount}, throttled like a local decode reporter. The
 * run-fn's `finish.usage` still carries the provider's billed totals and
 * supersedes these snapshots — do not use the provisional figures for cost math.
 */
export function createEstimatedOutputUsageReporter(
  emit: (event: StreamUsage) => void,
  options: {
    intervalMs?: number;
    now?: () => number;
  } = {}
): EstimatedOutputUsageReporter {
  const intervalMs = options.intervalMs ?? ESTIMATED_USAGE_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let input: number | undefined;
  let outputChars = 0;
  let lastEmit: number | undefined;
  let lastEmitted: { input: number | undefined; output: number } | undefined;

  const outputFromChars = (): number =>
    outputChars === 0 ? 0 : Math.ceil(outputChars / CHARS_PER_TOKEN_ESTIMATE);

  const snapshot = (): Usage => ({
    input,
    output: outputFromChars(),
    cached: undefined,
    cacheWrite: undefined,
    reasoning: undefined,
    total: undefined,
    extra: undefined,
    // Every counter here is a character-count guess. Tagging at the one place
    // they are minted marks them for every call site at once, so nothing
    // downstream prices or persists them as billed spend.
    estimated: true,
  });

  const send = (at: number): void => {
    const usage = snapshot();
    lastEmit = at;
    lastEmitted = { input: usage.input, output: usage.output ?? 0 };
    emit({ type: "usage", usage });
  };

  return {
    onPrompt: (text: string): void => {
      input = estimateTokenCount(text);
      // Emit even for an empty prompt so ↑0 is distinguishable from "unknown"
      // only when the caller actually invoked onPrompt — a zero-length prompt
      // still means the request carried no text.
      send(now());
    },
    onText: (text: string): void => {
      if (!text) return;
      outputChars += text.length;
      const at = now();
      if (lastEmit !== undefined && at - lastEmit < intervalMs) return;
      send(at);
    },
    flush: (): void => {
      if (input === undefined && outputChars === 0) return;
      const next = { input, output: outputFromChars() };
      if (lastEmitted && lastEmitted.input === next.input && lastEmitted.output === next.output) {
        return;
      }
      send(now());
    },
  };
}

function usageChanged(a: Usage, b: Usage): boolean {
  return USAGE_COUNTER_FIELDS.some((field) => a[field] !== b[field]);
}
