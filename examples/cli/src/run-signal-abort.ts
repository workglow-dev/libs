/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskAbortedError } from "@workglow/task-graph";

/** Unix 128 + SIGINT. What a shell reports for Ctrl-C, and what Abort sends. */
export const SIGINT_EXIT_CODE = 130;
/** Unix 128 + SIGTERM. */
export const SIGTERM_EXIT_CODE = 143;

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

export function isAbortError(error: unknown): boolean {
  if (error instanceof TaskAbortedError) return true;
  return error instanceof Error && (/abort/i.test(error.name) || /abort/i.test(error.message));
}

export function runFailureExitCode(error: unknown): number {
  return isAbortError(error) ? SIGINT_EXIT_CODE : 1;
}
