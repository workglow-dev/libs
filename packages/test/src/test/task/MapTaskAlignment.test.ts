/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { MapTask, Task, TaskGraph, TaskStatus } from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import { describe, expect, it } from "vitest";

/** Emits `even` only for even items, so that port is present in some iterations only. */
class EvenOnlyTask extends Task<{ n: number }, { n: number; even?: number }> {
  public static override type = "MapAlignment_EvenOnly";
  public static override cacheable = false;
  public static override inputSchema(): DataPortSchema {
    return { type: "object", properties: { n: { type: "number" } } } as const;
  }
  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: { n: { type: "number" }, even: { type: "number" } },
    } as const;
  }
  public override async execute(input: { n: number }) {
    return input.n % 2 === 0 ? { n: input.n, even: input.n } : { n: input.n };
  }
}

function mapOver(config: Record<string, unknown> = {}): MapTask {
  const sub = new TaskGraph();
  sub.addTask(new EvenOnlyTask({ id: "item" }));
  const map = new MapTask({ maxIterations: 100, ...config } as never);
  map.subGraph = sub;
  return map;
}

// A map's contract is one result per input. Compacting a port that only some iterations
// produce pairs each value with the wrong input: `even[0]` belonged to item 1, not item 0.
describe("MapTask output arrays line up with the input", () => {
  it("gives every port one slot per item, null where an iteration produced nothing", async () => {
    const out = await mapOver().run({ n: [1, 2, 3, 4] } as never);
    expect(out).toEqual({ n: [1, 2, 3, 4], even: [null, 2, null, 4] });
  });

  it("gives a declared port one null per item when no iteration produced it", async () => {
    const out = await mapOver().run({ n: [1, 3] } as never);
    expect(out).toEqual({ n: [1, 3], even: [null, null] });
  });

  it("keeps the ports aligned with each other when order is not preserved", async () => {
    const out = (await mapOver({ preserveOrder: false }).run({ n: [1, 2, 3, 4] } as never)) as {
      n: number[];
      even: (number | null)[];
    };
    expect(out.n).toHaveLength(4);
    expect(out.even).toHaveLength(4);
    out.n.forEach((n, i) => expect(out.even[i]).toBe(n % 2 === 0 ? n : null));
  });

  // Workers stop picking up items once a run is aborted; what they leave must not be
  // reported as a completed map with holes in it.
  it("an abort between iterations fails the run rather than returning partial arrays", async () => {
    const map = mapOver({ concurrencyLimit: 1 });
    // Aborted once the first iteration has finished, so no running iteration fails:
    // the workers simply stop picking up items.
    map.on("iteration_complete", (index: number) => {
      if (index === 0) map.abort();
    });
    await expect(map.run({ n: [1, 2, 3, 4] } as never)).rejects.toThrow();
    expect(map.status).not.toBe(TaskStatus.COMPLETED);
  });
});
