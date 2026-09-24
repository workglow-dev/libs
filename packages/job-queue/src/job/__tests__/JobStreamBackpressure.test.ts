/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { uuid4 } from "@workglow/util";
import { describe, expect, it } from "vitest";
import { InMemoryQueueStorage } from "../../queue-storage/InMemoryQueueStorage";
import { wrapQueueStorage } from "../../queue-storage/wrapQueueStorage";
import type { IJobExecuteContext } from "../Job";
import { Job } from "../Job";
import { JobQueueClient } from "../JobQueueClient";
import { JobQueueServer } from "../JobQueueServer";
import { JobQueueWorker } from "../JobQueueWorker";

interface EmitInput {
  readonly count: number;
}

/** Awaits every emit, recording how far it got before each await resolved. */
class AwaitingEmitJob extends Job<EmitInput, { emitted: number }> {
  static readonly type = "AwaitingEmitJob";
  public static observedAwaits = 0;
  override async execute(
    input: EmitInput,
    context: IJobExecuteContext
  ): Promise<{ emitted: number }> {
    AwaitingEmitJob.observedAwaits = 0;
    for (let i = 0; i < input.count; i++) {
      // emitStreamEvent's return is unconditionally a promise now — await it
      // directly, no `typeof maybe.then === "function"` sniffing required.
      await context.emitStreamEvent?.({
        type: "binary-delta",
        port: "bytes",
        binaryDelta: new Uint8Array([i]),
      });
      AwaitingEmitJob.observedAwaits++;
    }
    void context.emitStreamEvent?.({ type: "finish", data: {} });
    return { emitted: input.count };
  }
}

describe("emitStreamEvent is awaitable", () => {
  it("returns a thenable the job can await", async () => {
    const storage = new InMemoryQueueStorage<EmitInput, { emitted: number }>("bp-queue");
    await storage.migrate();
    const { messageQueue, jobStore } = wrapQueueStorage(storage);
    const server = new JobQueueServer<EmitInput, { emitted: number }>(AwaitingEmitJob as any, {
      messageQueue,
      jobStore,
      queueName: "bp-queue",
    });
    const client = new JobQueueClient<EmitInput, { emitted: number }>({
      messageQueue,
      jobStore,
      queueName: "bp-queue",
    });
    client.attach(server);
    await server.start();

    try {
      const received: string[] = [];
      const handle = await client.send({ count: 3 });
      handle.onStream?.(async (event) => {
        received.push(event.type);
      });
      const out = await handle.waitFor();

      expect(out.emitted).toBe(3);
      expect(AwaitingEmitJob.observedAwaits).toBe(3);
      expect(received.filter((t) => t === "binary-delta").length).toBe(3);
    } finally {
      await server.stop();
    }
  });

  it("a slow onStream listener paces the producing job", async () => {
    const storage = new InMemoryQueueStorage<EmitInput, { emitted: number }>("pace-queue");
    await storage.migrate();
    const { messageQueue, jobStore } = wrapQueueStorage(storage);
    // Strip BOTH halves of the cross-process channel — this is the actual
    // SQLite/Postgres shape, where neither method exists at all (not "one
    // stripped, one left behind": that combination exists on no real
    // backend, and `ensureStreamSubscription` treats it as channel-less
    // too — see `JobQueueClient.ts`). With no channel, the ONLY possible
    // pacing signal is the in-process fast-path dispatch this test exists to
    // cover; the old publish-chain promise resolved instantly here and
    // bought nothing.
    (messageQueue as { publishStreamChunk?: unknown }).publishStreamChunk = undefined;
    (messageQueue as { subscribeToStream?: unknown }).subscribeToStream = undefined;

    const server = new JobQueueServer<EmitInput, { emitted: number }>(AwaitingEmitJob as any, {
      messageQueue,
      jobStore,
      queueName: "pace-queue",
    });
    const client = new JobQueueClient<EmitInput, { emitted: number }>({
      messageQueue,
      jobStore,
      queueName: "pace-queue",
    });
    client.attach(server);
    await server.start();

    try {
      const order: string[] = [];
      const handle = await client.send({ count: 3 });
      handle.onStream?.(async (event) => {
        if (event.type !== "binary-delta") return;
        await new Promise((r) => setTimeout(r, 20));
        order.push("consumed");
      });
      await handle.waitFor();

      // Every emit must have waited for its consumer. If the dispatch path is
      // not awaited, the job finishes first and this is empty or short.
      expect(order.filter((o) => o === "consumed").length).toBe(3);
    } finally {
      await server.stop();
    }
  });

  it("a rejecting onStream listener is logged and never fails the job or the other listener", async () => {
    const storage = new InMemoryQueueStorage<EmitInput, { emitted: number }>("reject-queue");
    await storage.migrate();
    const { messageQueue, jobStore } = wrapQueueStorage(storage);
    const server = new JobQueueServer<EmitInput, { emitted: number }>(AwaitingEmitJob as any, {
      messageQueue,
      jobStore,
      queueName: "reject-queue",
    });
    const client = new JobQueueClient<EmitInput, { emitted: number }>({
      messageQueue,
      jobStore,
      queueName: "reject-queue",
    });
    client.attach(server);
    await server.start();

    try {
      const goodReceived: string[] = [];
      const handle = await client.send({ count: 3 });
      handle.onStream?.(async () => {
        throw new Error("misbehaving listener");
      });
      handle.onStream?.(async (event) => {
        goodReceived.push(event.type);
      });

      const out = await handle.waitFor();

      expect(out.emitted).toBe(3);
      expect(goodReceived.filter((t) => t === "binary-delta").length).toBe(3);
    } finally {
      await server.stop();
    }
  });
});

/** Parks forever on its first stream event, until the test releases it. */
class ParkingStreamJob extends Job<EmitInput, { emitted: number }> {
  static readonly type = "ParkingStreamJob";
  public static executions = 0;
  override async execute(
    _input: EmitInput,
    context: IJobExecuteContext
  ): Promise<{ emitted: number }> {
    ParkingStreamJob.executions++;
    await context.emitStreamEvent?.({ type: "text-delta", port: "p", textDelta: "x" });
    await context.emitStreamEvent?.({ type: "finish", data: {} });
    return { emitted: 1 };
  }
}

describe("a parked stream dispatch holds the job's claim", () => {
  it("is not reclaimed and re-executed while a consumer keeps it parked", async () => {
    // Backpressure makes a job's remaining runtime consumer-paced, so a slow
    // sink parks it mid-body for an unbounded time. Nothing else writes to
    // storage in between (updateProgress is in-memory only, the rest are
    // terminal), so without a claim heartbeat the lease expires, `next()`
    // reclaims the PROCESSING row — this worker's OWN poll loop is enough, no
    // second process required — and the re-execution replays the body onto the
    // subscription still parked on the first one. Measured before the fix:
    // 7 executions and 6 charged attempts in 400ms on a 60ms lease.
    ParkingStreamJob.executions = 0;
    const queueName = `park-lease-${uuid4()}`;
    const storage = new InMemoryQueueStorage<EmitInput, { emitted: number }>(queueName);
    await storage.migrate();
    const { messageQueue, jobStore } = wrapQueueStorage(storage);

    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const { promise: parked, resolve: markParked } = Promise.withResolvers<void>();

    // Built directly rather than through a server: the lease length is a
    // worker option, and the park is driven by the same `onStreamEvent` hook a
    // server injects to reach its attached clients.
    const worker = new JobQueueWorker<EmitInput, { emitted: number }>(ParkingStreamJob as any, {
      messageQueue,
      jobStore,
      queueName,
      pollIntervalMs: 1,
      leaseMs: 60,
      stopTimeoutMs: 0,
      onStreamEvent: async (_jobId, event) => {
        if (event.type !== "text-delta") return;
        markParked();
        await released;
      },
    });

    await messageQueue.send({ queue: queueName, input: { count: 1 }, status: "NEW" } as any);
    await worker.start();
    try {
      await parked;
      // Several lease periods' worth of parking.
      await new Promise((r) => setTimeout(r, 400));

      expect(ParkingStreamJob.executions).toBe(1);
      const row = (storage as unknown as { jobQueue: Array<Record<string, unknown>> }).jobQueue[0];
      // A reclaim charges an attempt each time it happens.
      expect(row.attempts ?? 0).toBe(0);
    } finally {
      release();
      await worker.stop();
    }
  });
});

/** Parks BEFORE its first stream event, where the stream heartbeat has not armed. */
class ParkedBeforeFirstEventJob extends Job<EmitInput, { emitted: number }> {
  static readonly type = "ParkedBeforeFirstEventJob";
  public static executions = 0;
  public static gate: Promise<void> = Promise.resolve();
  override async execute(): Promise<{ emitted: number }> {
    ParkedBeforeFirstEventJob.executions++;
    await ParkedBeforeFirstEventJob.gate;
    return { emitted: 0 };
  }
}

describe("a server passes its lease options to its workers", () => {
  async function executionsWhileParked(options: {
    readonly leaseMs: number;
    readonly extendLeaseWhileRunning?: boolean;
  }): Promise<number> {
    ParkedBeforeFirstEventJob.executions = 0;
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    ParkedBeforeFirstEventJob.gate = gate;
    const queueName = `server-lease-${uuid4()}`;
    const storage = new InMemoryQueueStorage<EmitInput, { emitted: number }>(queueName);
    await storage.migrate();
    const { messageQueue, jobStore } = wrapQueueStorage(storage);
    const server = new JobQueueServer<EmitInput, { emitted: number }>(
      ParkedBeforeFirstEventJob as any,
      { messageQueue, jobStore, queueName, pollIntervalMs: 1, stopTimeoutMs: 0, ...options }
    );
    await messageQueue.send({ queue: queueName, input: { count: 0 }, status: "NEW" } as any);
    await server.start();
    try {
      // Several lease periods' worth of running.
      await new Promise((r) => setTimeout(r, 400));
      return ParkedBeforeFirstEventJob.executions;
    } finally {
      release();
      await server.stop();
    }
  }

  it("reaches the worker's lease: a short one is reclaimed while the job still runs", async () => {
    // The control. The default lease is 30s, so a reclaim inside 400ms proves
    // the server's `leaseMs` reached the worker — and shows the hazard the
    // stream heartbeat cannot cover, since this job has emitted nothing.
    expect(await executionsWhileParked({ leaseMs: 60 })).toBeGreaterThan(1);
  });

  it("reaches extendLeaseWhileRunning: the running job keeps its claim", async () => {
    expect(await executionsWhileParked({ leaseMs: 60, extendLeaseWhileRunning: true })).toBe(1);
  });
});
