/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { InMemoryTabularStorage } from "@workglow/storage";
import { describe, expect, it } from "vitest";
import { GraphUsageAggregator } from "../../task-graph/GraphUsageAggregator";
import { RunUsagePrimaryKeyNames, RunUsageSchema } from "../RunUsageSchema";
import { attachUsageRecorder } from "../attachUsageRecorder";

const usage = (input: number, output: number) => ({
  input,
  output,
  cached: undefined,
  cacheWrite: undefined,
  reasoning: undefined,
  total: undefined,
  extra: undefined,
});

describe("attachUsageRecorder", () => {
  it("writes one row per retired execution, not per event", async () => {
    const storage = new InMemoryTabularStorage(RunUsageSchema, RunUsagePrimaryKeyNames);
    const aggregator = new GraphUsageAggregator();
    const detach = attachUsageRecorder(aggregator, storage, { runId: "run-1" });

    aggregator.observe("t1", usage(100, 1), "m");
    aggregator.observe("t1", usage(100, 5), "m");
    aggregator.observe("t1", usage(100, 9), "m");
    aggregator.retire("t1");
    await detach();

    const rows = (await storage.getAll()) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].output).toBe(9);
    expect(rows[0].taskId).toBe("t1");
    expect(rows[0].runId).toBe("run-1");
  });

  it("stores an unreported counter as null, never 0", async () => {
    const storage = new InMemoryTabularStorage(RunUsageSchema, RunUsagePrimaryKeyNames);
    const aggregator = new GraphUsageAggregator();
    const detach = attachUsageRecorder(aggregator, storage, { runId: "run-2" });

    aggregator.observe("t1", usage(10, 2), "m");
    aggregator.retire("t1");
    await detach();

    const rows = (await storage.getAll()) ?? [];
    // The zero-vs-absent rule has to survive into the database or it was never
    // really enforced.
    expect(rows[0].cached).toBe(null);
    expect(rows[0].cacheWrite).toBe(null);
    expect(rows[0].imageInput).toBe(null);
    expect(rows[0].imageCached).toBe(null);
  });

  it("persists only columns a writer can fill", async () => {
    const storage = new InMemoryTabularStorage(RunUsageSchema, RunUsagePrimaryKeyNames);
    const aggregator = new GraphUsageAggregator();
    const detach = attachUsageRecorder(aggregator, storage, { runId: "run-cols" });

    aggregator.observe("t1", usage(10, 2), "m");
    aggregator.retire("t1");
    await detach();

    const rows = (await storage.getAll()) ?? [];
    // A column no writer can populate is a promise the schema cannot keep: a
    // reader seeing `cost` in the table has every reason to expect a number in
    // it eventually, and nothing in this package can ever supply one.
    expect(Object.keys(rows[0]).sort()).toEqual([
      "cacheWrite",
      "cached",
      "createdAt",
      "extra",
      "imageCached",
      "imageInput",
      "input",
      "modelId",
      "output",
      "reasoning",
      "runId",
      "sequence",
      "taskId",
      "total",
    ]);
  });

  it("gives a task that executes twice two rows", async () => {
    const storage = new InMemoryTabularStorage(RunUsageSchema, RunUsagePrimaryKeyNames);
    const aggregator = new GraphUsageAggregator();
    const detach = attachUsageRecorder(aggregator, storage, { runId: "run-3" });

    aggregator.observe("loop", usage(10, 1), "m");
    aggregator.retire("loop");
    aggregator.observe("loop", usage(10, 1), "m");
    aggregator.retire("loop");
    await detach();

    const rows = (await storage.getAll()) ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.sequence).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([0, 1]);
  });

  it("writes no row for an estimated execution", async () => {
    const storage = new InMemoryTabularStorage(RunUsageSchema, RunUsagePrimaryKeyNames);
    const aggregator = new GraphUsageAggregator();
    const detach = attachUsageRecorder(aggregator, storage, { runId: "run-4" });

    aggregator.observe("t1", { ...usage(30, 2), estimated: true as const }, "m");
    aggregator.observe("t2", usage(10, 1), "m");
    aggregator.sweep();
    await detach();

    const rows = (await storage.getAll()) ?? [];
    // `run_usage` has no column that could say "this figure is a guess", so a
    // recorded estimate is indistinguishable from billed spend forever after.
    // The recorder is not changed to filter — it writes one row per retirement,
    // and an estimated bucket is never retired.
    expect(rows.map((r) => r.taskId)).toEqual(["t2"]);
  });
});
