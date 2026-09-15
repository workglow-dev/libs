/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IJobExecuteContext } from "@workglow/job-queue";
import {
  AbortSignalJobError,
  declaredRetryability,
  Job,
  PermanentJobError,
  RetryableJobError,
  withJobErrorDiagnostics,
} from "@workglow/job-queue";
import type { TaskInput, TaskOutput } from "@workglow/task-graph";
import type { JsonSchema } from "@workglow/util/schema";
import type { AiEmit } from "../capability/AiEmit";
import type { Capability } from "../capability/Capabilities";
import type { ModelConfig } from "../model/ModelSchema";
import type { AiSessionContext } from "../provider/AiProviderRegistry";
import { getAiProviderRegistry } from "../provider/AiProviderRegistry";

/** Default timeout for provider API calls (60 minutes). */
const DEFAULT_AI_TIMEOUT_MS = 60 * 60 * 1000;

/** Local inference (CPU/WASM) often needs several minutes (downloads, load, multi-turn tool follow-up). */
const LOCAL_INFERENCE_DEFAULT_TIMEOUT_MS = 120 * 60_000;

/**
 * Cross-runtime macrotask yield. Tight microtask-only `await` chains starve
 * V8 GC + FinalizationRegistry callbacks, which on ONNX/WASM workloads pins
 * native handles (session memory, KV cache) for the lifetime of the suite
 * rather than releasing them per call. One macrotask boundary per AI job
 * lets the event loop drain those finalizers between calls.
 */
const yieldMacrotask: () => Promise<void> =
  typeof setImmediate === "function"
    ? () => new Promise<void>((resolve) => setImmediate(resolve))
    : () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function resolveAiJobTimeoutMs(aiProvider: string, explicitMs: number | undefined): number {
  if (explicitMs !== undefined) {
    return explicitMs;
  }
  if (
    aiProvider === "LOCAL_LLAMACPP" ||
    aiProvider === "HF_TRANSFORMERS_ONNX" ||
    aiProvider === "WEB_BROWSER"
  ) {
    return LOCAL_INFERENCE_DEFAULT_TIMEOUT_MS;
  }
  return DEFAULT_AI_TIMEOUT_MS;
}

/**
 * Input data for the AiJob.
 *
 * `taskType` is retained as observability / queue-key metadata only — dispatch
 * resolves the run function via `requires` against the provider's capability-set
 * registrations. Both fields travel together so logs and queue keys remain stable
 * even though the registry is now keyed by capability sets.
 */
export interface AiJobInput<Input extends TaskInput = TaskInput> {
  taskType: string;
  /**
   * Capability set the job requires from the provider. The dispatcher passes
   * this to {@link AiProviderRegistry.getRunFnFor} to resolve a streaming run
   * function. An empty array matches the smallest registration available.
   */
  requires: readonly Capability[];
  aiProvider: string;
  taskInput: Input & { model: ModelConfig };
  /** JSON Schema for structured output, when the task declares x-structured-output. */
  outputSchema?: JsonSchema;
  /** Timeout in milliseconds for the provider API call. Defaults to 120s. */
  timeoutMs?: number;
  /** Session / cache-checkpoint context forwarded to the provider run function. */
  session?: AiSessionContext;
}

/**
 * Classifies a provider error as retryable or permanent based on known patterns.
 * Returns a RetryableJobError for transient issues (rate limits, network errors,
 * server errors) and a PermanentJobError for non-recoverable issues (auth, not found).
 *
 * The heuristics below are the LAST resort, for a provider that classified
 * nothing. An error that states an answer — any error, in or out of this
 * package — is taken at its word first, because the code that threw it saw the
 * failure and this function only sees a string.
 */
export function classifyProviderError(err: unknown, taskType: string, provider: string): Error {
  if (
    err instanceof PermanentJobError ||
    err instanceof RetryableJobError ||
    err instanceof AbortSignalJobError
  ) {
    return err;
  }

  const message = err instanceof Error ? err.message : String(err);

  const status =
    typeof (err as any)?.status === "number"
      ? (err as any).status
      : typeof (err as any)?.statusCode === "number"
        ? (err as any).statusCode
        : (() => {
            // Only treat a 4xx/5xx number as an HTTP status when it appears in
            // an HTTP-shaped context (e.g. "HTTP 503", "status: 429"). A bare
            // number like the "512" in "Sequence length 512 exceeds limit" or a
            // model id must not be scavenged as a status, or it misclassifies.
            const m = message.match(
              /\b(?:HTTP\/?\d?\.?\d?\s*|status(?:\s*code)?\s*(?:[:=]\s*)?)([45]\d{2})\b/i
            );
            return m ? parseInt(m[1], 10) : undefined;
          })();

  // `name` is one of the two fields that survive a worker boundary, so it is
  // also how an `AbortSignalJobError` thrown in a worker is recognised — the
  // `instanceof` above only ever sees the ones thrown in this process.
  if (err instanceof Error && (err.name === "AbortError" || err.name === "AbortSignalJobError")) {
    return new AbortSignalJobError(
      withJobErrorDiagnostics(`Provider call aborted for ${taskType} (${provider})`, err)
    );
  }
  if (err instanceof Error && err.name === "TimeoutError") {
    return new AbortSignalJobError(
      withJobErrorDiagnostics(`Provider call timed out for ${taskType} (${provider})`, err)
    );
  }
  // Catch abort patterns re-thrown as plain Errors (e.g. "Pipeline download aborted" from HFT)
  if (
    message.includes("Pipeline download aborted") ||
    message.includes("Operation aborted") ||
    message.includes("operation was aborted") ||
    message.includes("The operation was aborted")
  ) {
    return new AbortSignalJobError(
      withJobErrorDiagnostics(
        `Provider call aborted for ${taskType} (${provider}): ${message}`,
        err
      )
    );
  }

  // Read as a declaration, not as a class: an error thrown in a worker reaches
  // here flattened — `ImageGenerationProviderError`, and the `JobError`
  // subclasses above, all arrive as a plain `Error` — and this flag is what
  // crosses with it. Testing the classes instead honoured a provider's answer
  // only where it was registered inline, and read every worker-backed
  // provider's classification as an unlabelled failure to pattern-match.
  //
  // It sits after the abort checks and before the heuristics: an abort is a
  // different question from a retry, and a stated answer beats a guess made
  // from the message.
  const declared = declaredRetryability(err);
  if (declared !== undefined) {
    return declared
      ? new RetryableJobError(withJobErrorDiagnostics(message, err))
      : new PermanentJobError(withJobErrorDiagnostics(message, err));
  }

  // Incomplete model cache (e.g. missing preprocessor_config.json) — let the queue retry
  // so the provider re-downloads missing files on the next attempt.
  // The "HFT_NULL_PROCESSOR:" prefix is produced by HFT_Pipeline.ts
  // (HFT_NULL_PROCESSOR_PREFIX constant) when an image processor fails to initialize.
  if (message.startsWith("HFT_NULL_PROCESSOR:")) {
    return new RetryableJobError(withJobErrorDiagnostics(message, err));
  }

  if (status === 429) {
    const retryAfterMatch = message.match(/retry.after[:\s]*(\d+)/i);
    const retryMs = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) * 1000 : 30_000;
    return new RetryableJobError(
      withJobErrorDiagnostics(`Rate limited by ${provider} for ${taskType}: ${message}`, err),
      new Date(Date.now() + retryMs)
    );
  }

  if (status === 401 || status === 403) {
    return new PermanentJobError(
      withJobErrorDiagnostics(
        `Authentication failed for ${provider} (${taskType}): ${message}`,
        err
      )
    );
  }

  if (status === 400 || status === 404) {
    return new PermanentJobError(
      withJobErrorDiagnostics(`Invalid request to ${provider} for ${taskType}: ${message}`, err)
    );
  }

  if (status && status >= 500) {
    return new RetryableJobError(
      withJobErrorDiagnostics(
        `Server error from ${provider} for ${taskType} (HTTP ${status}): ${message}`,
        err
      )
    );
  }

  if (
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    (err instanceof TypeError && message.includes("fetch"))
  ) {
    return new RetryableJobError(
      withJobErrorDiagnostics(`Network error calling ${provider} for ${taskType}: ${message}`, err)
    );
  }

  if (message.includes("timed out") || message.includes("timeout")) {
    return new RetryableJobError(
      withJobErrorDiagnostics(`Timeout calling ${provider} for ${taskType}: ${message}`, err)
    );
  }

  // Default: treat unknown errors as permanent to avoid infinite retries.
  return new PermanentJobError(
    withJobErrorDiagnostics(`Provider ${provider} failed for ${taskType}: ${message}`, err)
  );
}

export class AiJob<
  Input extends AiJobInput<TaskInput> = AiJobInput<TaskInput>,
  Output extends TaskOutput = TaskOutput,
> extends Job<Input, Output> {
  /**
   * Executes the job by dispatching to the registered run function and
   * forwarding every emitted event to the caller-supplied `emit`. The Promise
   * carries no data — output rides on the `finish` event (or accumulated
   * deltas + trailing empty `finish` for streaming capabilities).
   *
   * AiJob dispatches via `emit` rather than returning output, so it overrides
   * `Job<Input, Output>`'s `execute(input, ctx): Promise<Output>` with an extra
   * `emit` param and a `Promise<void>` return. It still needs Job's
   * progress-event / status machinery, so we keep the inheritance but accept
   * the intentional override signature mismatch.
   *
   * @override Deliberate signature deviation: adds `emit` param, returns `Promise<void>`.
   */
  // @ts-expect-error — intentional signature deviation; see JSDoc above.
  override async execute(
    input: Input,
    context: IJobExecuteContext,
    emit: AiEmit<Output>
  ): Promise<void> {
    if (context.signal.aborted) {
      throw new AbortSignalJobError("Abort signal aborted before execution of job");
    }

    const fn = getAiProviderRegistry().getRunFnFor<Input["taskInput"], Output>(
      input.aiProvider,
      input.requires
    );
    if (!fn) {
      throw new Error(
        `No run function found for provider "${input.aiProvider}" serving capabilities ` +
          `[${input.requires.join(", ")}] (task: ${input.taskType}).`
      );
    }

    // Manual timeout (replaces AbortSignal.timeout — that one's timer is
    // uncancellable per Web spec, leaks per call). Manual timeout + explicit
    // listener pair (replaces AbortSignal.any, which retains downstream
    // listeners on the parent signal).
    const timeoutMs = resolveAiJobTimeoutMs(input.aiProvider, input.timeoutMs);
    const localController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      localController.abort(new Error("AI job timed out"));
    }, timeoutMs);
    const onParentAbort = () => {
      localController.abort(context.signal.reason);
    };
    context.signal.addEventListener("abort", onParentAbort, { once: true });

    try {
      if (context.signal.aborted) {
        throw new AbortSignalJobError("Job aborted");
      }
      const model = input.taskInput.model;
      await fn(
        input.taskInput,
        model,
        localController.signal,
        emit,
        input.outputSchema,
        input.session
      );
    } catch (err) {
      throw classifyProviderError(err, input.taskType, input.aiProvider);
    } finally {
      clearTimeout(timeoutHandle);
      context.signal.removeEventListener("abort", onParentAbort);
      await yieldMacrotask();
    }
  }
}
