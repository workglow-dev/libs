/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskAbortedError, TaskTimeoutError } from "@workglow/task-graph";

/** Unix 128 + SIGINT. What a shell reports for Ctrl-C, and what Abort sends. */
export const SIGINT_EXIT_CODE = 130;
/** Unix 128 + SIGTERM. */
export const SIGTERM_EXIT_CODE = 143;

/**
 * Latched for the life of the process: the listener is detached in
 * {@link runWithProcessSignalAbort}'s `finally`, which runs before the
 * rejection it caused reaches the command's catch, so the question "did WE
 * cancel this run?" can only be answered from state that outlives the install.
 */
let signalAbortRequested = false;

/** Whether a SIGINT/SIGTERM has asked this process to abort its run. */
export function runAbortedBySignal(): boolean {
  return signalAbortRequested;
}

/** Tests emit real signals into this process; nothing clears the latch in a real run. */
export function resetRunSignalAbortForTesting(): void {
  signalAbortRequested = false;
}

export interface RunSignalAbortOptions {
  readonly abort: () => void;
  /** Injected so tests can observe a second-signal force-exit. */
  readonly exit?: (code: number) => void;
}

/**
 * First SIGINT/SIGTERM cooperatively aborts the in-flight run. A second of
 * either insists, because adding a listener removes Node/Bun's default
 * "die immediately" action for that signal — without a force-exit, a hung
 * abort would leave the process unkillable except by SIGKILL.
 *
 * Does not exit on the first signal: the run still has to reject so the CLI
 * can report `run_end` aborted, and callers such as agent chat can swallow a
 * cancelled turn without ending the session.
 */
export function installRunSignalAbort(options: RunSignalAbortOptions): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let signaled: NodeJS.Signals | undefined;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (signaled !== undefined) {
      exit(signal === "SIGTERM" ? SIGTERM_EXIT_CODE : SIGINT_EXIT_CODE);
      return;
    }
    signaled = signal;
    signalAbortRequested = true;
    options.abort();
  };

  const onInt = (): void => onSignal("SIGINT");
  const onTerm = (): void => onSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return () => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  };
}

/**
 * Runs `execute` with SIGINT/SIGTERM mapped onto `abort`, then detaches.
 */
export async function runWithProcessSignalAbort<T>(
  abort: () => void,
  execute: () => Promise<T>
): Promise<T> {
  const detach = installRunSignalAbort({ abort });
  try {
    return await execute();
  } finally {
    detach();
  }
}

/**
 * Cancellation, as opposed to failure — the class decides, never the message.
 *
 * `TaskTimeoutError` and `TaskGraphTimeoutError` extend {@link TaskAbortedError}
 * because a timeout cancels the run, but they are failures with a message the
 * operator needs, as is any error that merely describes itself as "aborted"
 * (a fetch, a job). Only a bare abort — and a genuine `AbortError`, which is how
 * `DOMException` and web APIs spell one — is a cancellation here.
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof TaskAbortedError) return !(error instanceof TaskTimeoutError);
  if (typeof error !== "object" || error === null) return false;
  return (error as { name?: unknown }).name === "AbortError";
}

/**
 * Whether this failure is the process cancelling its own run, and so is already
 * explained by the Ctrl-C that caused it. Everything else keeps its message,
 * including a cancellation nothing here asked for.
 */
export function isSignalCancellation(error: unknown): boolean {
  return runAbortedBySignal() && isAbortError(error);
}

export function runFailureExitCode(error: unknown): number {
  return isAbortError(error) ? SIGINT_EXIT_CODE : 1;
}
