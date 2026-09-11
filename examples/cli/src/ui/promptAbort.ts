/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/** The part of an Ink instance a prompt has to take back. */
export interface PromptInstance {
  clear(): void;
  unmount(): void;
}

/**
 * Gives the terminal back when the caller stops waiting.
 *
 * A prompt mounts an Ink app and resolves when a person answers it; neither is
 * reachable from outside, so an aborted run would otherwise leave the app on
 * screen and the promise pending forever.
 *
 * **Detach when the prompt settles.** `clear()` writes an erase sequence to
 * stdout, so a listener left attached past a normal answer wipes whatever is on
 * screen the next time the run aborts — in a session that keeps its transcript
 * in scrollback, that is the conversation. A run holding one signal across
 * several prompts would also stack a listener per prompt, and erase once each.
 *
 * @returns the detach, which is safe to call more than once and when no signal
 *   was given.
 */
export function releaseOnAbort(
  signal: AbortSignal | undefined,
  instance: PromptInstance,
  resolve: (value: undefined) => void
): () => void {
  if (!signal) return () => {};
  const release = (): void => {
    instance.clear();
    instance.unmount();
    resolve(undefined);
  };
  if (signal.aborted) {
    release();
    return () => {};
  }
  signal.addEventListener("abort", release, { once: true });
  return () => signal.removeEventListener("abort", release);
}
