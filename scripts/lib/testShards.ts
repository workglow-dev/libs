/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Splitting ONE runner invocation's file list into N interchangeable pieces, so
 * a slice too big for a single CI job can run as several parallel ones.
 *
 * The unit slice is what forced this: ~700 files, four times the wall clock of
 * every other job in the workflow, so the run finished when it did and nothing
 * else on the board mattered. Almost none of that is test execution — summed
 * over the slice, the tests themselves account for about a fifth of it — and the
 * rest is per-file cost: transform, import, a fresh module registry per file.
 * That is what makes splitting by FILE COUNT the right model here. Weighting by
 * measured duration would need a committed timings table that goes stale in
 * silence, and it would be balancing the fifth of the cost that is not the
 * problem.
 */

/** One piece of a partition, spelled the way the CLI takes it: `--shard 2/4`. */
export interface Shard {
  /** 1-based, so `2/4` is the second of four rather than the third. */
  readonly index: number;
  readonly count: number;
}

export type ShardParseResult =
  | { readonly ok: true; readonly shard: Shard }
  | { readonly ok: false; readonly error: string };

/**
 * Parse an `<index>/<count>` value.
 *
 * Every malformed spelling is refused rather than coerced. A shard argument is
 * written once in a workflow file and then read by nobody, and each way it can
 * be wrong silently runs the wrong tests: `0/4` and `5/4` resolve to an empty
 * shard that passes, and a bare `4` would be a quarter of the suite reported as
 * all of it.
 */
export function parseShard(raw: string | undefined): ShardParseResult {
  const value = raw?.trim() ?? "";
  if (value.length === 0 || value.startsWith("-")) {
    return { ok: false, error: "--shard needs an <index>/<count> value, e.g. --shard 2/4" };
  }
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (match === null) {
    return { ok: false, error: `--shard expects <index>/<count>, got "${value}"` };
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count < 1) return { ok: false, error: `--shard count must be at least 1, got ${count}` };
  if (index < 1 || index > count) {
    return {
      ok: false,
      error: `--shard index must be between 1 and ${count}, got ${index}`,
    };
  }
  return { ok: true, shard: { index, count } };
}

/**
 * The files belonging to `shard`, dealt round-robin from a sorted list.
 *
 * Two properties carry the whole design, and both are about correctness rather
 * than speed:
 *
 * - **Sorted first.** Discovery walks the tree in `readdirSync` order and each
 *   shard runs on its own machine, so an unsorted input makes "2 of 4" mean
 *   whatever that machine's enumeration happened to be — and then a file can
 *   land in two shards, or in none and never run, with nothing in any job's
 *   output to say so. The comparison is a plain byte ordering rather than
 *   `localeCompare` (which the runner's own ordering uses) for the same reason:
 *   collation is a property of the environment, and this must not be.
 * - **Dealt, not sliced.** Adjacent paths are the same directory, which is one
 *   package's tests against one module graph — so contiguous blocks put a
 *   package's whole cost on one shard, while dealing spreads every directory
 *   across all of them. Each shard ends up with the same shape of work, which
 *   is what keeps the slowest shard close to the average one.
 */
export function shardFiles(files: readonly string[], shard: Shard): string[] {
  if (shard.count === 1) return [...files];
  return [...files]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .filter((_, i) => i % shard.count === shard.index - 1);
}
