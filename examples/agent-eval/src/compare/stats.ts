/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Interval {
  readonly low: number;
  readonly high: number;
}

/**
 * Wilson score interval for a pass rate. Benchmark arms are small (tens of
 * tasks) and rates near 0 or 1 are common, which is where the normal
 * approximation gives intervals outside [0, 1].
 */
export function wilsonInterval(successes: number, trials: number, z = 1.96): Interval {
  if (trials === 0) return { low: 0, high: 0 };
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function logChoose(n: number, k: number): number {
  let sum = 0;
  for (let i = 1; i <= k; i++) sum += Math.log(n - k + i) - Math.log(i);
  return sum;
}

/**
 * Unbiased pass@k for one task from n attempts with c passes (Chen et al.,
 * 2021): the chance that at least one of k attempts drawn without replacement
 * passes.
 */
export function passAtK(n: number, c: number, k: number): number {
  if (k > n) throw new Error(`pass@${k} needs at least ${k} attempts, got ${n}`);
  if (n - c < k) return 1;
  return 1 - Math.exp(logChoose(n - c, k) - logChoose(n, k));
}

/**
 * Exact two-sided McNemar test on the discordant pairs of a paired
 * comparison: `onlyA` tasks the first arm solved and the second did not, and
 * the reverse. The concordant tasks carry no information about which arm is
 * better, which is why a paired test needs far fewer tasks than comparing two
 * pass rates as if they were independent samples.
 */
export function mcnemarExactP(onlyA: number, onlyB: number): number {
  const n = onlyA + onlyB;
  if (n === 0) return 1;
  const k = Math.min(onlyA, onlyB);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
