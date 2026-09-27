/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IJobExecuteContext, JobStorageFormat } from "@workglow/job-queue";
import {
  InMemoryQueueStorage,
  Job,
  JobQueueClient,
  JobQueueServer,
  JobStatus,
  wrapQueueStorage,
} from "@workglow/job-queue";
import { setLogger, sleep, uuid4 } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { describe, expect, it } from "vitest";

interface TI {
  readonly taskType?: string;
  readonly data?: string;
  readonly [key: string]: unknown;
}
interface TO {
  readonly result?: string;
  readonly [key: string]: unknown;
}

class TJob extends Job<TI, TO> {
  public override async execute(input: TI, context: IJobExecuteContext): Promise<TO> {
    if (input.taskType === "long_running") {
      return new Promise<TO>((_, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("Aborted")), {
          once: true,
        });
      });
    }
    return { result: "done" };
  }
}

/** Counts claim attempts; optionally hides its change feed. */
class CountingStorage extends InMemoryQueueStorage<TI, TO> {
  public nextCalls = 0;
  public constructor(
    queueName: string,
    private readonly withChangeFeed: boolean
  ) {
    super(queueName);
  }
  public override async next(
    workerId: string,
    opts?: { leaseMs?: number }
  ): Promise<JobStorageFormat<TI, TO> | undefined> {
    this.nextCalls++;
    return super.next(workerId, opts);
  }
  public override subscribeToChanges(
    ...args: Parameters<InMemoryQueueStorage<TI, TO>["subscribeToChanges"]>
  ): () => void {
    if (!this.withChangeFeed) throw new Error("change feed unavailable");
    return super.subscribeToChanges(...args);
  }
}

async function setup(opts: {
  pollIntervalMs: number;
  maxIdlePollIntervalMs?: number;
  withChangeFeed?: boolean;
}) {
  const queueName = `idle-backoff-${uuid4()}`;
  const storage = new CountingStorage(queueName, opts.withChangeFeed ?? true);
  await storage.migrate();
  const { messageQueue, jobStore } = wrapQueueStorage(storage);
  const server = new JobQueueServer<TI, TO, TJob>(TJob, {
    messageQueue,
    jobStore,
    queueName,
    pollIntervalMs: opts.pollIntervalMs,
    maxIdlePollIntervalMs: opts.maxIdlePollIntervalMs,
    stopTimeoutMs: 0,
  });
  const client = new JobQueueClient<TI, TO>({ messageQueue, jobStore, queueName });
  client.attach(server);
  await server.start();
  return { storage, jobStore, server, client };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, ceilingMs: number) {
  const deadline = Date.now() + ceilingMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(5);
  }
  return false;
}

describe("JobQueueWorker idle backoff", () => {
  setLogger(getTestingLogger());

  it("backs an empty queue's polling off instead of claiming at the poll interval", async () => {
    const backoff = await setup({ pollIntervalMs: 1, maxIdlePollIntervalMs: 200 });
    const flat = await setup({ pollIntervalMs: 1, maxIdlePollIntervalMs: 1 });
    await sleep(800);
    await backoff.server.stop();
    await flat.server.stop();

    // 1, 2, 4, ... 128, then 200ms steps: about a dozen claims in 800ms. The
    // flat worker claims on every ~1ms iteration.
    expect(backoff.storage.nextCalls).toBeLessThan(25);
    expect(flat.storage.nextCalls).toBeGreaterThan(backoff.storage.nextCalls * 4);
  });

  it("an announced submit still wakes a backed-off worker immediately", async () => {
    const { server, client } = await setup({ pollIntervalMs: 1, maxIdlePollIntervalMs: 60_000 });
    await sleep(300);

    const start = Date.now();
    const handle = await client.send({ taskType: "default", data: "x" });
    const result = await Promise.race([
      handle.waitFor(),
      sleep(2_000).then(() => "TIMEOUT" as const),
    ]);
    expect(result).toEqual({ result: "done" });
    expect(Date.now() - start).toBeLessThan(1_000);
    await server.stop();
  });

  it("finds unannounced work within the idle ceiling", async () => {
    // No change feed and a direct storage write: nothing calls notify, so only
    // the bounded poll can find the row — the other-process-writer case.
    const { storage, server } = await setup({
      pollIntervalMs: 1,
      maxIdlePollIntervalMs: 150,
      withChangeFeed: false,
    });
    await sleep(500);

    await storage.add({
      input: { taskType: "default", data: "unannounced" },
      visible_at: null,
      completed_at: null,
      deadline_at: null,
    } as unknown as JobStorageFormat<TI, TO>);
    const picked = await waitUntil(
      async () => (await storage.size(JobStatus.PENDING)) === 0,
      1_000
    );
    expect(picked).toBe(true);
    await server.stop();
  });

  it("wakes for a deferred job at its visible_at after backing off", async () => {
    const { server, client } = await setup({ pollIntervalMs: 1, maxIdlePollIntervalMs: 60_000 });
    await sleep(300);

    const start = Date.now();
    const handle = await client.send({ taskType: "default", data: "later" }, { delaySeconds: 0.3 });
    const result = await Promise.race([
      handle.waitFor(),
      sleep(3_000).then(() => "TIMEOUT" as const),
    ]);
    expect(result).toEqual({ result: "done" });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1_500);
    await server.stop();
  });

  it("keeps polling at the poll interval while a job runs, so storage aborts land promptly", async () => {
    const { server, client, jobStore } = await setup({
      pollIntervalMs: 5,
      maxIdlePollIntervalMs: 60_000,
    });
    const handle = await client.send({ taskType: "long_running", data: "abort-me" });
    const running = await waitUntil(
      async () => (await jobStore.get(handle.id))?.status === JobStatus.PROCESSING,
      1_000
    );
    expect(running).toBe(true);
    // Idle long enough that an unconditional backoff would be seconds deep.
    await sleep(400);

    // Through storage, not the client: the path another process takes, which
    // only the worker's polling can observe.
    await jobStore.abort(handle.id);
    const settled = await waitUntil(async () => {
      const status = (await jobStore.get(handle.id))?.status;
      return status !== JobStatus.PROCESSING;
    }, 1_000);
    expect(settled).toBe(true);
    await server.stop();
  });
});

describe("InMemoryQueueStorage claim order", () => {
  it("claims the earliest visible_at first, ties in insertion order, then expired leases", async () => {
    const storage = new InMemoryQueueStorage<TI, TO>(`order-${uuid4()}`);
    const base = Date.now() - 10_000;
    const at = (ms: number) => new Date(base + ms).toISOString();
    const add = (data: string, visible_at: string) =>
      storage.add({
        input: { data },
        visible_at,
        completed_at: null,
        deadline_at: null,
      } as unknown as JobStorageFormat<TI, TO>);

    await add("c", at(300));
    await add("a1", at(100));
    await add("b", at(200));
    await add("a2", at(100));
    await add("future", new Date(Date.now() + 60_000).toISOString());

    const peeked = await storage.peek(JobStatus.PENDING, 10);
    expect(peeked.map((j) => j.input.data)).toEqual(["a1", "a2", "b", "c", "future"]);
    expect((await storage.peek(JobStatus.PENDING, 2)).map((j) => j.input.data)).toEqual([
      "a1",
      "a2",
    ]);

    const claimed: string[] = [];
    for (let i = 0; i < 4; i++) {
      const job = await storage.next("w", { leaseMs: 1 });
      if (!job) break;
      claimed.push(job.input.data as string);
    }
    // Ready rows first, in visible_at order. The deferred row is not claimable
    // yet; once the 1ms leases expire, the oldest-visible one is reclaimed.
    expect(claimed).toEqual(["a1", "a2", "b", "c"]);
    await sleep(5);
    const reclaimed = await storage.next("w2", { leaseMs: 30_000 });
    expect(reclaimed?.input.data).toBe("a1");
    expect(reclaimed?.attempts).toBe(1);
    expect((await storage.peek(JobStatus.PROCESSING, 10)).map((j) => j.input.data)).toEqual([
      "a1",
      "a2",
      "b",
      "c",
    ]);
  });
});
