/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { deadlineSignal } from "../AgentToolExecution";

const MAX_TIMER_MS = 2_147_483_647;

describe("deadlineSignal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts at a deadline too far off for one timer, and not before", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const days = 30 * 24 * 60 * 60 * 1000;
    const { signal } = deadlineSignal(Date.now() + days);
    // An overflowed timer would have fired at once.
    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(MAX_TIMER_MS);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(days - MAX_TIMER_MS - 2);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
  });

  it("stops when cancelled", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { signal, cancel } = deadlineSignal(Date.now() + 100);
    cancel();
    vi.advanceTimersByTime(1_000);
    expect(signal.aborted).toBe(false);
  });
});
