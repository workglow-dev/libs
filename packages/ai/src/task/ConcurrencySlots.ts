/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

export type Slots = <T>(work: () => Promise<T>) => Promise<T>;

/**
 * Runs at most `limit` pieces of work at once, the rest in the order they asked.
 *
 * A finished piece hands its slot straight to the next waiter rather than freeing it:
 * a waiter resumes a tick after it is woken, and a slot freed in that tick was taken
 * by whoever asked next as well, so both ran.
 */
export function createSlots(limit: number): Slots {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running < limit) running++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}
