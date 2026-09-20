/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  IExecuteContext,
  SubGraphRunRequest,
  SubGraphStreamItem,
  TaskInput,
} from "@workglow/task-graph";
import {
  runSubGraphStreamRequest,
  Task,
  TaskRegistry,
  WorkerSubGraphDispatcher,
  Workflow,
} from "@workglow/task-graph";
import { ServiceRegistry, WORKER_MANAGER } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import { afterAll, describe, expect, it } from "vitest";

type Out = { text: string };

/** Emits three deltas on a declared streaming port, then finishes. */
class StreamingProbeTask extends Task<TaskInput, Out> {
  public static override type = "SubGraphStream_Probe";
  public static override inputSchema(): DataPortSchema {
    return { type: "object", properties: {}, additionalProperties: true } as const;
  }
  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { text: { type: "string", "x-stream": "append" } },
      additionalProperties: false,
    } as const as DataPortSchema;
  }
  override async *executeStream(
    _input: TaskInput,
    _context: IExecuteContext
  ): AsyncGenerator<unknown> {
    for (const piece of ["al", "pha", "!"]) {
      yield { type: "text-delta", port: "text", textDelta: piece };
    }
    yield { type: "finish", data: { text: "alpha!" } };
  }
}

TaskRegistry.registerTask(StreamingProbeTask);
afterAll(() => TaskRegistry.unregisterTask(StreamingProbeTask.type));

function probeRequest(): SubGraphRunRequest {
  const wf = new Workflow();
  wf.pipe(new StreamingProbeTask());
  return { graph: wf.graph.toJSON(), input: {} };
}

describe("runSubGraphStreamRequest", () => {
  it("forwards port-tagged chunks before the terminal results", async () => {
    const items: SubGraphStreamItem[] = [];
    await runSubGraphStreamRequest(probeRequest(), undefined, (item) => {
      items.push(item);
    });

    const kinds = items.map((i) => i.kind);
    expect(kinds[kinds.length - 1]).toBe("results");
    // Everything before the single terminal item is a chunk or a bridged
    // per-task event; `results` arrives exactly once, and last.
    expect(kinds.slice(0, -1).every((k) => k === "chunk" || k === "event")).toBe(true);
    expect(kinds.filter((k) => k === "results")).toHaveLength(1);

    const deltas = items
      .filter((i): i is Extract<SubGraphStreamItem, { kind: "chunk" }> => i.kind === "chunk")
      .map((i) => i.chunk.event)
      .filter(
        (e): e is { type: "text-delta"; port: string; textDelta: string } =>
          (e as { type?: string }).type === "text-delta"
      );

    expect(deltas.length).toBeGreaterThan(0);
    // The port survives the boundary, which is what routing a chunk to an edge needs.
    expect(deltas.every((d) => d.port === "text")).toBe(true);
    expect(deltas.map((d) => d.textDelta).join("")).toBe("alpha!");
  });

  it("preserves chunk order even when the consumer awaits out of step", async () => {
    const seen: string[] = [];
    let delay = 3;

    await runSubGraphStreamRequest(probeRequest(), undefined, async (item) => {
      if (item.kind === "event") return;
      if (item.kind !== "chunk") {
        seen.push("results");
        return;
      }
      const event = item.chunk.event as { type: string; textDelta?: string };
      // Decreasing delays: a forwarder that did not serialize its awaits would
      // let a later chunk overtake an earlier one here.
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.max(0, delay - 1);
      if (event.type === "text-delta") seen.push(event.textDelta ?? "");
    });

    expect(seen).toEqual(["al", "pha", "!", "results"]);
  });

  it("does not emit results before a slow consumer has taken every chunk", async () => {
    let chunksTaken = 0;
    let resultsAt = -1;

    await runSubGraphStreamRequest(probeRequest(), undefined, async (item) => {
      if (item.kind === "event") return;
      if (item.kind === "chunk") {
        await new Promise((resolve) => setTimeout(resolve, 1));
        chunksTaken++;
        return;
      }
      resultsAt = chunksTaken;
    });

    // The terminal item waited for the forwarding tail to drain.
    expect(resultsAt).toBeGreaterThan(0);
    expect(resultsAt).toBe(chunksTaken);
  });
});

/**
 * Stands in for the worker side of the run-fn protocol, recording when each
 * emit's promise settles. That settling is what the manager credits on, so it
 * is the observable form of "the consumer paced the producer".
 */
function pacingManager(itemCount: number) {
  const settledAt: number[] = [];
  let pulled = 0;

  const manager = {
    async callWorkerRunFunction(
      _worker: string,
      _fn: string,
      _args: unknown[],
      options: {
        emit: (item: SubGraphStreamItem) => void | Promise<void>;
        signal?: AbortSignal;
      }
    ): Promise<void> {
      for (let i = 0; i < itemCount; i++) {
        // A real worker call is cancelled by this signal; the fake honours it
        // so the early-break case proves the producer actually stops.
        if (options.signal?.aborted === true) return;
        await Promise.resolve(
          options.emit({
            kind: "chunk",
            chunk: { taskId: "t", event: { type: "text-delta", port: "text", textDelta: `${i}` } },
          } as SubGraphStreamItem)
        );
        settledAt.push(pulled);
      }
      await Promise.resolve(
        options.emit({ kind: "results", results: [] } as unknown as SubGraphStreamItem)
      );
    },
  };

  return { manager, settledAt, pull: () => ++pulled };
}

describe("WorkerSubGraphDispatcher.runSubGraphStream", () => {
  it("resolves each emit only once the consumer has pulled it", async () => {
    const { manager, settledAt, pull } = pacingManager(3);
    const registry = new ServiceRegistry();
    registry.registerInstance(WORKER_MANAGER, manager as never);
    const dispatcher = new WorkerSubGraphDispatcher("fake", registry);

    const kinds: string[] = [];
    for await (const item of dispatcher.runSubGraphStream(probeRequest())) {
      pull();
      kinds.push(item.kind);
    }

    expect(kinds).toEqual(["chunk", "chunk", "chunk", "results"]);
    // Each emit settles exactly as its item is taken from the one-item slot,
    // which is the tick before the consumer's own counter moves — so emit N
    // cannot settle until item N-1 has been taken. A producer running ahead
    // into a buffer would settle every emit up front, as [0, 0, 0].
    expect(settledAt).toEqual([0, 1, 2]);
  });

  it("stops the producer when the consumer breaks early", async () => {
    const { manager, settledAt, pull } = pacingManager(50);
    const registry = new ServiceRegistry();
    registry.registerInstance(WORKER_MANAGER, manager as never);
    const dispatcher = new WorkerSubGraphDispatcher("fake", registry);

    for await (const item of dispatcher.runSubGraphStream(probeRequest())) {
      pull();
      if (item.kind === "chunk") break;
    }

    // A break must not leave the worker producing into a channel nobody reads.
    // One or two may be in flight; fifty means nothing stopped.
    expect(settledAt.length).toBeLessThan(5);
  });
});
