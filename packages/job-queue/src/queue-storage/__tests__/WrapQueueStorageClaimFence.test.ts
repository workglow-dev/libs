/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IQueueStorage } from "@workglow/job-queue";
import {
  InMemoryQueueStorage,
  isLeaseLostError,
  JobStatus,
  TelemetryQueueStorage,
  wrapQueueStorage,
} from "@workglow/job-queue";
import { sleep, uuid4 } from "@workglow/util";
import { describe, expect, it } from "vitest";

type Row = Record<string, unknown>;

/** An in-memory store presented without the optional fenced write, as a custom store may be. */
function withoutFinalizeClaim(inner: InMemoryQueueStorage<Row, Row>): IQueueStorage<Row, Row> {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "finalizeClaim") return undefined;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as IQueueStorage<Row, Row>;
}

async function rejection(write: Promise<void>): Promise<unknown> {
  try {
    await write;
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("wrapQueueStorage claim fence", () => {
  it("refuses a stale claim through the read-check-write fallback", async () => {
    const queueName = `fallback-${uuid4()}`;
    const inner = new InMemoryQueueStorage<Row, Row>(queueName);
    const storage = withoutFinalizeClaim(inner);
    expect(storage.finalizeClaim).toBeUndefined();
    const { messageQueue } = wrapQueueStorage(storage);

    const id = await messageQueue.send({ queue: queueName, input: {}, status: "PENDING" } as any);
    const [stale] = await messageQueue.receive({ workerId: "worker-a", leaseMs: 1 });
    await sleep(10);
    const [fresh] = await messageQueue.receive({ workerId: "worker-b", leaseMs: 30_000 });
    expect(fresh?.id).toBe(id);

    expect(isLeaseLostError(await rejection(stale!.ack({ done: "stale" })))).toBe(true);
    expect(isLeaseLostError(await rejection(stale!.retry()))).toBe(true);
    const row = await storage.get(id);
    expect(row?.status).toBe(JobStatus.PROCESSING);
    expect(row?.lease_owner).toBe("worker-b");

    // The owner's retry still goes through `complete()`, which charges the attempt.
    await fresh!.retry();
    const retried = await storage.get(id);
    expect(retried?.status).toBe(JobStatus.PENDING);
    expect(retried?.attempts).toBe(fresh!.attempts + 1);
  });

  it("TelemetryQueueStorage forwards the fenced write", async () => {
    const inner = new InMemoryQueueStorage<Row, Row>(`telemetry-${uuid4()}`);
    const wrapped = new TelemetryQueueStorage<Row, Row>("InMemoryQueueStorage", inner);
    expect(typeof wrapped.finalizeClaim).toBe("function");
    expect(withoutFinalizeClaim(inner).finalizeClaim).toBeUndefined();
    expect(
      new TelemetryQueueStorage<Row, Row>("x", withoutFinalizeClaim(inner)).finalizeClaim
    ).toBeUndefined();
  });
});
