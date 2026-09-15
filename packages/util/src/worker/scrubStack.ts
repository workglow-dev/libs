/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { asText } from "../utilities/asText";

/**
 * Replace each `root` prefix in `stack` with the literal placeholder
 * `<root>` so absolute filesystem paths (build-server home dirs, container
 * layouts, customer-specific deployment roots) don't leak through error
 * surfaces.
 *
 * Pure helper — returns the input unchanged when `stack` is undefined or
 * the `roots` list is empty. Multiple roots are applied in order;
 * empty-string roots are skipped (avoids replacing every empty position
 * with `<root>`).
 */
export function scrubStack(
  stack: string | undefined,
  roots: readonly string[]
): string | undefined {
  if (!stack) return stack;
  let out = stack;
  for (const root of roots) {
    if (!root) continue;
    out = out.split(root).join("<root>");
  }
  return out;
}

/**
 * Filesystem roots for {@link scrubStack}. Node/Bun return `process.cwd()`; browser
 * workers often define `process` without `cwd`, so this returns `[]` there.
 */
export function stackScrubRoots(): readonly string[] {
  try {
    if (typeof process !== "undefined" && typeof process.cwd === "function") {
      const cwd = process.cwd();
      return cwd ? [cwd] : [];
    }
  } catch {
    // ignore — unavailable in some worker runtimes
  }
  return [];
}

/**
 * The structured-cloned shape of a worker `error` message.
 *
 * A thrown value cannot cross a worker boundary as itself: its class, its
 * prototype and every field not named here are gone on the other side. So what
 * this carries is the whole of what a caller can learn about a worker failure,
 * and a fact left out of it is a fact the main thread has to guess at.
 *
 * `retryable` is here for that reason. Whether a failure is worth another
 * attempt is decided in the worker — it is the code that saw the status line,
 * the socket close, the refusal — and a boolean is the only form that survives
 * the trip. Without it a transient failure reaches the main thread as an
 * anonymous `Error`, and a caller with no evidence has to assume permanent.
 */
export interface WorkerErrorPayload {
  readonly message: string;
  readonly name: string;
  readonly stack?: string;
  readonly retryable?: boolean;
}

/**
 * Flattens a thrown value into a {@link WorkerErrorPayload}.
 *
 * `includeStack` is the caller's decision because a stack is the one field
 * that can leak deployment paths; when it is passed through, `roots` scrubs
 * them.
 */
export function workerErrorPayload(
  error: unknown,
  options: { readonly includeStack: boolean; readonly roots: readonly string[] }
): WorkerErrorPayload {
  if (!(error instanceof Error)) {
    return { message: typeof error === "string" ? error : String(error), name: "Error" };
  }
  const scrubbed = options.includeStack ? scrubStack(error.stack, options.roots) : undefined;
  const retryable = (error as { retryable?: unknown }).retryable;
  return {
    message: error.message,
    name: error.name,
    ...(scrubbed !== undefined ? { stack: scrubbed } : {}),
    ...(typeof retryable === "boolean" ? { retryable } : {}),
  };
}

/**
 * Rebuilds an `Error` from the structured-cloned payload of a worker `error`
 * message. Defense-in-depth: a third-party worker that didn't go through our
 * scrubbing postError may still ship absolute paths in `data.stack`, so the
 * stack is re-scrubbed with the manager process's roots before the rehydrated
 * Error is handed to the caller.
 *
 * `retryable` is restored only when the payload actually carried a boolean. An
 * absent flag stays absent rather than becoming `false`: "the worker said
 * nothing" and "the worker said no" read the same to a consumer defaulting to
 * permanent, but only the second is a claim, and stamping one would make every
 * pre-existing worker look like it had made it.
 */
export function rehydrateWorkerError(data: unknown): Error {
  if (typeof data !== "object" || data === null) {
    return new Error(String(data));
  }
  const payload = data as Partial<WorkerErrorPayload>;
  const scrubbedStack =
    typeof payload.stack === "string" ? scrubStack(payload.stack, stackScrubRoots()) : undefined;
  return Object.assign(new Error(payload.message ?? asText(data)), {
    name: payload.name ?? "Error",
    ...(scrubbedStack !== undefined ? { stack: scrubbedStack } : {}),
    ...(typeof payload.retryable === "boolean" ? { retryable: payload.retryable } : {}),
  });
}
