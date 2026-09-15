/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { discoverTestFiles, matchesKind } from "./lib/testDiscovery";
import type { Shard } from "./lib/testShards";
import { parseShard, shardFiles } from "./lib/testShards";

function shard(index: number, count: number): Shard {
  return { index, count };
}

describe("parseShard", () => {
  it("accepts an <index>/<count> value", () => {
    expect(parseShard("2/4")).toEqual({ ok: true, shard: { index: 2, count: 4 } });
    expect(parseShard(" 1/1 ")).toEqual({ ok: true, shard: { index: 1, count: 1 } });
  });

  /**
   * Each of these runs the wrong tests rather than failing: an out-of-range
   * index resolves to an empty shard, which is a legitimate outcome on a
   * `--changed` run and so passes, and a bare count would be one piece of the
   * suite reported as all of it.
   */
  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["a bare number", "4"],
    ["the next flag, when the value is missing", "--dry-run"],
    ["a zero index", "0/4"],
    ["an index past the count", "5/4"],
    ["a zero count", "1/0"],
    ["a non-numeric value", "a/b"],
    ["a three-part value", "1/2/3"],
  ])("refuses %s", (_label, value) => {
    const parsed = parseShard(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("--shard");
  });
});

describe("shardFiles", () => {
  it("is the whole list when there is one shard", () => {
    const files = ["b.test.ts", "a.test.ts"];
    expect(shardFiles(files, shard(1, 1))).toEqual(files);
  });

  it("partitions: every file lands in exactly one shard", () => {
    const files = Array.from({ length: 37 }, (_, i) => `f${i}.test.ts`);
    const pieces = [1, 2, 3, 4, 5].map((i) => shardFiles(files, shard(i, 5)));
    expect(pieces.flat().sort()).toEqual([...files].sort());
  });

  it("keeps the shards within one file of each other", () => {
    const files = Array.from({ length: 37 }, (_, i) => `f${i}.test.ts`);
    const sizes = [1, 2, 3, 4, 5].map((i) => shardFiles(files, shard(i, 5)).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  /**
   * Each shard runs on its own machine, against a list discovery built by
   * walking the tree in `readdirSync` order. If the partition depended on that
   * order, "2 of 4" would mean something different per machine — and then a
   * file can land in two shards, or in none and never run at all, with every
   * job still green.
   */
  it("does not depend on the order of its input", () => {
    const files = Array.from({ length: 37 }, (_, i) => `f${i}.test.ts`);
    const reversed = [...files].reverse();
    for (const i of [1, 2, 3, 4, 5]) {
      expect(shardFiles(reversed, shard(i, 5))).toEqual(shardFiles(files, shard(i, 5)));
    }
  });

  it("spreads a directory across the shards rather than onto one", () => {
    // Contiguous slices would put all of `a/` on one shard and all of `b/` on
    // another, so one package's whole cost lands in one job.
    const files = [
      ...Array.from({ length: 8 }, (_, i) => `a/${i}.test.ts`),
      ...Array.from({ length: 8 }, (_, i) => `b/${i}.test.ts`),
    ];
    for (const i of [1, 2, 3, 4]) {
      const piece = shardFiles(files, shard(i, 4));
      expect(piece.filter((f) => f.startsWith("a/")).length).toBe(2);
      expect(piece.filter((f) => f.startsWith("b/")).length).toBe(2);
    }
  });

  it("gives more shards than files the extra shards as empty", () => {
    const files = ["a.test.ts", "b.test.ts"];
    expect(shardFiles(files, shard(1, 4))).toEqual(["a.test.ts"]);
    expect(shardFiles(files, shard(2, 4))).toEqual(["b.test.ts"]);
    expect(shardFiles(files, shard(3, 4))).toEqual([]);
    expect(shardFiles(files, shard(4, 4))).toEqual([]);
  });

  /** The property over the real tree: the four unit shards CI runs are the unit slice. */
  it("covers the whole unit slice across the four shards CI runs", () => {
    const unit = discoverTestFiles()
      .filter((f) => f.runner !== "bun")
      .filter((f) => matchesKind(f.path, ["unit"]))
      .map((f) => f.path);
    expect(unit.length).toBeGreaterThan(0);
    const pieces = [1, 2, 3, 4].map((i) => shardFiles(unit, shard(i, 4)));
    expect(pieces.flat().sort()).toEqual([...unit].sort());
  });
});
