/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DataPortSchema } from "@workglow/util/schema";
import { describe, expect, it } from "vitest";
import { CacheCoordinator } from "../CacheCoordinator";
import type { Usage } from "../StreamTypes";
import { CACHE_HIT_USAGE, mergeUsage } from "../StreamTypes";
import { Task } from "../Task";
import { TaskRegistry } from "../TaskRegistry";
import { TaskRunContext } from "../TaskRunContext";

describe("cache-hit usage", () => {
  it("states zero for every counter and leaves extra unreported", () => {
    // A replayed output verifiably cost nothing — that is a stated zero, not an
    // unknown. `extra` has no meaningful zero (it may hold a model id), so it
    // stays undefined.
    expect(CACHE_HIT_USAGE).toEqual({
      input: 0,
      output: 0,
      cached: 0,
      cacheWrite: 0,
      imageInput: 0,
      imageCached: 0,
      reasoning: 0,
      total: 0,
      extra: undefined,
    });
  });

  it("adds nothing to a run total, and does not fabricate partner counters", () => {
    const spent: Usage = {
      input: 5,
      output: 2,
      cached: undefined,
      cacheWrite: undefined,
      reasoning: undefined,
      total: undefined,
      extra: undefined,
    };

    const merged = mergeUsage(spent, CACHE_HIT_USAGE);

    // The counters the other task DID report are unchanged by a free cache hit.
    expect(merged?.input).toBe(5);
    expect(merged?.output).toBe(2);
    // But a stated zero does make previously-unreported counters reported, since
    // the cache hit genuinely states 0 for them. That is honest, and harmless:
    // 0 is the right answer for a replayed output.
    expect(merged?.cached).toBe(0);
    expect(merged?.imageInput).toBe(0);
    expect(merged?.imageCached).toBe(0);
  });
});

describe("mergeUsage and the estimated flag", () => {
  const stated: Usage = {
    input: 10,
    output: 4,
    cached: undefined,
    cacheWrite: undefined,
    reasoning: undefined,
    total: undefined,
    extra: undefined,
  };
  const guessed: Usage = { ...stated, input: 3, output: 1, estimated: true };

  it("marks a total that mixes a guess with a stated figure", () => {
    // Nothing in a merged Usage records which counter came from which side, so
    // one estimated contributor makes the whole total an estimate. The
    // alternative is a total that reads as billed but is partly invented.
    expect(mergeUsage(stated, guessed)?.estimated).toBe(true);
    expect(mergeUsage(guessed, stated)?.estimated).toBe(true);
  });

  it("leaves no key at all on a wholly stated total", () => {
    const merged = mergeUsage(stated, stated)!;
    // Absent, not present-and-undefined: the value is serialized whole in
    // places (stream events, cached outputs), and an explicit `undefined` would
    // survive into shapes that only ever carried the original counters.
    expect("estimated" in merged).toBe(false);
  });

  it("carries the flag through a single-sided merge", () => {
    expect(mergeUsage(undefined, guessed)?.estimated).toBe(true);
    expect(mergeUsage(guessed, undefined)?.estimated).toBe(true);
  });
});

// ============================================================================
// Integration: CacheCoordinator.lookup() driving a real task, asserting the
// observable effects a unit test on CACHE_HIT_USAGE / mergeUsage alone cannot
// reach — task.runUsage and the emitted "usage" event.
// ============================================================================

type CacheableInput = { q: string };
type CacheableOutput = { result: string };

class UsageCacheableTask extends Task<CacheableInput, CacheableOutput> {
  static override readonly type = "UsageCacheableTask";
  static override readonly category = "Test";
  static override readonly cacheable = true;
  static override readonly title = "Usage cacheable";
  static override readonly description =
    "Cacheable task fixture for cache-hit usage integration tests.";

  static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { q: { type: "string" } },
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  override async execute(input: CacheableInput): Promise<CacheableOutput> {
    return { result: input.q };
  }
}

class FakeCacheRepo {
  private readonly store = new Map<string, unknown>();

  async getOutput(type: string, input: unknown): Promise<unknown> {
    return this.store.get(`${type}::${JSON.stringify(input)}`);
  }

  async saveOutput(type: string, input: unknown, output: unknown): Promise<void> {
    this.store.set(`${type}::${JSON.stringify(input)}`, output);
  }
}

describe("cache-hit usage emit, driven through CacheCoordinator.lookup()", () => {
  it("sets task.runUsage and delivers a usage event to subscribers on a real cache hit", async () => {
    TaskRegistry.registerTask(UsageCacheableTask);
    const task = new UsageCacheableTask();
    const cache = new FakeCacheRepo() as any;
    await cache.saveOutput("UsageCacheableTask", { q: "hello" }, { result: "cached!" });

    const cc = new CacheCoordinator<CacheableInput, CacheableOutput>(task);
    const ctx = new TaskRunContext();

    const seen: Usage[] = [];
    task.subscribe("usage", (u: Usage) => seen.push(u));

    const result = await cc.lookup({ q: "hello" }, cache, { kind: "deterministic" }, false, ctx);

    expect(result).toEqual({ result: "cached!" });
    expect(task.runUsage).toEqual(CACHE_HIT_USAGE);
    expect(seen).toEqual([CACHE_HIT_USAGE]);
  });

  it("does not touch runUsage or publish a usage event on a cache miss", async () => {
    TaskRegistry.registerTask(UsageCacheableTask);
    const task = new UsageCacheableTask();
    const cache = new FakeCacheRepo() as any; // left empty: nothing saved for this key

    const cc = new CacheCoordinator<CacheableInput, CacheableOutput>(task);
    const ctx = new TaskRunContext();

    const seen: Usage[] = [];
    task.subscribe("usage", (u: Usage) => seen.push(u));

    const result = await cc.lookup(
      { q: "not-cached" },
      cache,
      { kind: "deterministic" },
      false,
      ctx
    );

    expect(result).toBeUndefined();
    expect(task.runUsage).toBeUndefined();
    expect(seen).toEqual([]);
  });
});
