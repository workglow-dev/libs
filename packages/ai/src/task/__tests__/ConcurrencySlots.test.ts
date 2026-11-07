/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { createSlots } from "../ConcurrencySlots";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createSlots", () => {
  // A freed slot is handed to the caller that waited for it. Freeing it first and
  // letting the waiter take it a tick later left it open to a caller arriving in that
  // tick, and both ran. Which tick that is depends on the engine's await hops, so the
  // late caller is tried at each of the first few.
  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    "never runs more than its limit when a caller arrives %i ticks into a handover",
    async (ticks) => {
      const slots = createSlots(1);
      let inFlight = 0;
      let peak = 0;
      const track = async (gate: Promise<void>) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await gate;
        inFlight--;
      };
      // One microtask per await; a promise returned from a `then` callback would cost three.
      const afterTicks = async (n: number): Promise<void> => {
        for (let i = 0; i < n; i++) await Promise.resolve();
      };

      const first = deferred();
      // Held open until the end, so work that both got a slot is seen running together.
      const hold = deferred();
      const a = slots(() => track(first.promise));
      const b = slots(() => track(hold.promise));
      first.resolve();
      const c = afterTicks(ticks).then(() => slots(() => track(hold.promise)));
      await afterTicks(ticks + 10);
      hold.resolve();
      await Promise.all([a, b, c]);

      expect(peak).toBe(1);
    }
  );

  it("runs waiters in the order they asked", async () => {
    const slots = createSlots(1);
    const order: number[] = [];
    const first = deferred();
    const runs = [
      slots(async () => {
        await first.promise;
        order.push(0);
      }),
      ...[1, 2, 3].map((n) => slots(async () => void order.push(n))),
    ];
    first.resolve();
    await Promise.all(runs);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("frees the slot when the work throws", async () => {
    const slots = createSlots(1);
    await expect(slots(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(slots(async () => "ok")).resolves.toBe("ok");
  });
});
