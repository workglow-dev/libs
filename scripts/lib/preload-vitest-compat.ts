/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fills the gaps in Bun's built-in `vitest` compatibility shim so the same test
 * files run under both runners.
 *
 * `bun test` resolves `import { vi } from "vitest"` to its own shim rather than
 * to the real package. That shim covers mocks, spies and fake timers, but not
 * `setSystemTime`, the global/env stubbing pair, the async timer variants or
 * `waitFor` — a test using any of those throws `vi.X is not a function` under
 * Bun while passing under Vitest. The shim exposes one shared `vi` object, so a
 * preload can install the missing members once for every test file.
 *
 * Only referenced from `bunfig.toml`'s `[test].preload`; Vitest keeps its real
 * implementations. Each addition is guarded so a future Bun release that ships
 * its own version wins.
 */

import { setSystemTime } from "bun:test";
import { vi } from "vitest";

/** The shim's members are untyped from here; `vi`'s published type already declares them all. */
const target = vi as unknown as Record<string, unknown>;

function define(name: string, value: unknown): void {
  if (typeof target[name] !== "function") target[name] = value;
}

// ── System time ───────────────────────────────────────────────────────────────
// Bun's fake timers already advance `Date.now()` and `useRealTimers()` restores
// the real clock, so the whole gap is the setter itself.
define("setSystemTime", (time?: string | number | Date): typeof vi => {
  setSystemTime(time === undefined ? undefined : new Date(time));
  return vi;
});

// ── Global stubs ──────────────────────────────────────────────────────────────
/** First-seen value per stubbed global, so nested stubs restore the pre-test value. */
const globalStubs = new Map<PropertyKey, { readonly existed: boolean; readonly value: unknown }>();

define("stubGlobal", (name: PropertyKey, value: unknown): typeof vi => {
  if (!globalStubs.has(name)) {
    globalStubs.set(name, {
      existed: name in globalThis,
      value: (globalThis as Record<PropertyKey, unknown>)[name],
    });
  }
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return vi;
});

define("unstubAllGlobals", (): typeof vi => {
  for (const [name, previous] of globalStubs) {
    if (previous.existed) {
      Object.defineProperty(globalThis, name, {
        value: previous.value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } else {
      delete (globalThis as Record<PropertyKey, unknown>)[name];
    }
  }
  globalStubs.clear();
  return vi;
});

// ── Environment stubs ─────────────────────────────────────────────────────────
const envStubs = new Map<string, string | undefined>();

define("stubEnv", (name: string, value: string | undefined): typeof vi => {
  if (!envStubs.has(name)) envStubs.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return vi;
});

define("unstubAllEnvs", (): typeof vi => {
  for (const [name, previous] of envStubs) {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  envStubs.clear();
  return vi;
});

// ── Async timer variants ──────────────────────────────────────────────────────
/**
 * Vitest interleaves the host's queues with each timer callback; Bun's timers
 * are synchronous. Draining after the advance covers the cases these suites
 * need — a timer whose callback awaits before resolving.
 *
 * The drain must not touch the clock: Bun's `advanceTimersByTime(0)` still
 * advances a full millisecond, so using it as a "flush" makes a timer due at
 * `t` fire while the test believes it is standing at `t - 1`.
 */
async function drainPendingWork(): Promise<void> {
  for (let i = 0; i < 32; i += 1) await Promise.resolve();
}

const advanceTimersByTime = (ms: number): void => {
  // Same reason: only a positive advance is a real advance under Bun.
  if (ms > 0)
    (vi as unknown as { advanceTimersByTime: (ms: number) => unknown }).advanceTimersByTime(ms);
};

define("advanceTimersByTimeAsync", async (ms: number): Promise<typeof vi> => {
  advanceTimersByTime(ms);
  await drainPendingWork();
  return vi;
});

define("advanceTimersToNextTimerAsync", async (): Promise<typeof vi> => {
  (vi as unknown as { advanceTimersToNextTimer: () => unknown }).advanceTimersToNextTimer();
  await drainPendingWork();
  return vi;
});

define("runAllTimersAsync", async (): Promise<typeof vi> => {
  (vi as unknown as { runAllTimers: () => unknown }).runAllTimers();
  await drainPendingWork();
  return vi;
});

define("runOnlyPendingTimersAsync", async (): Promise<typeof vi> => {
  (vi as unknown as { runOnlyPendingTimers: () => unknown }).runOnlyPendingTimers();
  await drainPendingWork();
  return vi;
});

// ── Polling ───────────────────────────────────────────────────────────────────
/**
 * Retries `callback` until it stops throwing — or its promise stops rejecting —
 * and resolves with whatever it returned. A timeout throws the LAST error the
 * callback produced, so the report names the assertion that never held rather
 * than the wait around it.
 *
 * Two properties are worth keeping, both Vitest's:
 *
 * - The deadline is armed on the timer captured at preload, before any test can
 *   install a fake one, so a callback whose promise never settles still rejects
 *   instead of hanging until the runner's own timeout.
 * - Under fake timers the wait between attempts ADVANCES the clock rather than
 *   sleeping. What is being waited for is driven by those timers, so a real
 *   sleep would sit out the whole timeout without it ever progressing.
 */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

async function waitOneInterval(interval: number): Promise<void> {
  if ((vi as unknown as { isFakeTimers: () => boolean }).isFakeTimers()) {
    advanceTimersByTime(interval);
    await drainPendingWork();
    return;
  }
  await new Promise<void>((resolve) => realSetTimeout(resolve, interval));
}

define(
  "waitFor",
  <T>(
    callback: () => T | Promise<T>,
    options?: number | { readonly timeout?: number; readonly interval?: number }
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const { timeout = 1000, interval = 50 } =
        typeof options === "number" ? { timeout: options } : (options ?? {});

      let lastError: unknown;
      let settled = false;
      const deadline = realSetTimeout(() => {
        settled = true;
        reject(lastError ?? new Error(`Timed out in waitFor after ${timeout}ms`));
      }, timeout);

      void (async () => {
        while (!settled) {
          try {
            const value = await callback();
            if (settled) return;
            settled = true;
            realClearTimeout(deadline);
            resolve(value);
            return;
          } catch (err) {
            lastError = err;
          }
          if (settled) return;
          await waitOneInterval(interval);
        }
        // Nothing here throws today, but an unhandled rejection from this
        // detached loop would be reported against whatever test runs next.
      })().catch((err: unknown) => {
        lastError = err;
      });
    })
);

// ── Type-level helpers ────────────────────────────────────────────────────────
// `vi.mocked` and `vi.hoisted` are identity functions at runtime in Vitest too.
define("mocked", <T>(item: T): T => item);
define("hoisted", <T>(factory: () => T): T => factory());
