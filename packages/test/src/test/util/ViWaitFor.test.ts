/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `vi.waitFor` is absent from Bun's vitest compatibility shim and supplied by
 * `scripts/lib/preload-vitest-compat.ts`, so under Bun these assertions cover
 * the fill-in and under Vitest the real implementation. That is the point of
 * running them: the two have to answer the same, and nothing else in the repo
 * exercises `waitFor` often enough to notice when they stop.
 *
 * The timeout case matters most. A wait that reports its own expiry hides the
 * assertion that never held, which is the only part of the failure worth
 * reading.
 */
describe("vi.waitFor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the callback's value once it stops throwing", async () => {
    let attempts = 0;
    const value = await vi.waitFor(
      () => {
        attempts += 1;
        if (attempts < 3) throw new Error("not yet");
        return "ready";
      },
      { timeout: 2000, interval: 5 }
    );
    expect(value).toBe("ready");
    expect(attempts).toBe(3);
  });

  it("awaits a callback that returns a promise, and retries a rejected one", async () => {
    let attempts = 0;
    const value = await vi.waitFor(
      async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("not yet");
        return 42;
      },
      { timeout: 2000, interval: 5 }
    );
    expect(value).toBe(42);
    expect(attempts).toBe(2);
  });

  it("throws the callback's last error when the timeout expires", async () => {
    await expect(
      vi.waitFor(
        () => {
          throw new Error("the assertion that never held");
        },
        { timeout: 60, interval: 5 }
      )
    ).rejects.toThrow("the assertion that never held");
  });

  it("gives up on a callback whose promise never settles", async () => {
    // Without a deadline armed outside the callback this hangs until the
    // runner's own timeout kills the file, naming no test in particular.
    await expect(
      vi.waitFor(() => new Promise<never>(() => {}), { timeout: 60, interval: 5 })
    ).rejects.toThrow();
  });

  it("advances fake timers between attempts instead of sleeping through them", async () => {
    vi.useFakeTimers();
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 500);

    // Nothing else moves this clock, so a wait that merely slept would hand
    // back the timeout with the timer still pending. The deadline is the other
    // half of the same case: it has to stay on a real timer, or expiry itself
    // becomes something only the wait could advance.
    await vi.waitFor(() => expect(fired).toBe(true), { timeout: 3000, interval: 20 });
    expect(fired).toBe(true);
  });
});
