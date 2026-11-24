/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IJobExecuteContext } from "@workglow/job-queue";
import {
  InMemoryQueueStorage,
  isLeaseLostError,
  Job,
  JobQueueWorker,
  JobStatus,
  wrapQueueStorage,
} from "@workglow/job-queue";
import { setLogger, sleep, uuid4 } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface LeaseInput {
  readonly mode: "until-abort" | "sleep";
  readonly ms?: number;
  readonly [key: string]: unknown;
}
interface LeaseOutput {
  readonly done: boolean;
  readonly [key: string]: unknown;
}

/** Records every execution and the reason its signal was aborted with. */
class LeaseJob extends Job<LeaseInput, LeaseOutput> {
  public static executions = 0;
  public static abortReasons: unknown[] = [];

  public override async execute(
    input: LeaseInput,
    context: IJobExecuteContext
  ): Promise<LeaseOutput> {
    LeaseJob.executions += 1;
    return new Promise<LeaseOutput>((resolve, reject) => {
      const onAbort = (): void => {
        LeaseJob.abortReasons.push(context.signal.reason);
        reject(context.signal.reason ?? new Error("aborted"));
      };
      context.signal.addEventListener("abort", onAbort, { once: true });
      if (input.mode === "sleep") {
        setTimeout(() => {
          context.signal.removeEventListener("abort", onAbort);
          resolve({ done: true });
        }, input.ms ?? 100);
      }
    });
  }
}

interface Harness {
  readonly storage: InMemoryQueueStorage<LeaseInput, LeaseOutput>;
  readonly worker: JobQueueWorker<LeaseInput, LeaseOutput>;
  readonly events: string[];
  readonly send: (input: LeaseInput) => Promise<unknown>;
}

async function harness(options: {
  readonly leaseMs: number;
  readonly extendLeaseWhileRunning: boolean;
}): Promise<Harness> {
  const queueName = `lease-loss-${uuid4()}`;
  const storage = new InMemoryQueueStorage<LeaseInput, LeaseOutput>(queueName);
  await storage.migrate();
  const { messageQueue, jobStore } = wrapQueueStorage(storage);
  const worker = new JobQueueWorker<LeaseInput, LeaseOutput>(LeaseJob as any, {
    messageQueue,
    jobStore,
    queueName,
    pollIntervalMs: 1,
    stopTimeoutMs: 0,
    workerId: "worker-a",
    ...options,
  });
  const events: string[] = [];
  worker.on("job_complete", () => events.push("job_complete"));
  worker.on("job_error", () => events.push("job_error"));
  worker.on("job_retry", () => events.push("job_retry"));
  worker.on("job_disabled", () => events.push("job_disabled"));
  worker.on("job_lease_lost", () => events.push("job_lease_lost"));
  const send = (input: LeaseInput): Promise<unknown> =>
    messageQueue.send({ queue: queueName, input, status: JobStatus.PENDING } as any);
  return { storage, worker, events, send };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(5);
  }
}

describe("JobQueueWorker on a lost lease", () => {
  let h: Harness | undefined;

  beforeEach(() => {
    setLogger(getTestingLogger());
    LeaseJob.executions = 0;
    LeaseJob.abortReasons = [];
  });

  afterEach(async () => {
    await h?.worker.stop();
    h = undefined;
  });

  it("aborts the execution when a renewal finds another worker owns the row", async () => {
    h = await harness({ leaseMs: 60, extendLeaseWhileRunning: true });
    const id = await h.send({ mode: "until-abort" });
    await h.worker.start();
    await waitFor(() => LeaseJob.executions === 1);

    // Another worker takes the row over (as a reclaim after a missed renewal
    // would): the row is PROCESSING under a different owner.
    await h.storage.finalize(id, { lease_owner: "worker-b" });
    await h.storage.extendLease(id, "worker-b", 30_000);

    await waitFor(() => h!.events.includes("job_lease_lost"));
    expect(LeaseJob.abortReasons).toHaveLength(1);
    expect(isLeaseLostError(LeaseJob.abortReasons[0])).toBe(true);
    // No outcome is reported for the abandoned execution, and the new
    // owner's row is untouched.
    await sleep(50);
    expect(h.events).toEqual(["job_lease_lost"]);
    const row = await h.storage.get(id);
    expect(row?.status).toBe(JobStatus.PROCESSING);
    expect(row?.lease_owner).toBe("worker-b");
    expect(row?.error ?? null).toBeNull();
  });

  it("refuses the result of an execution whose lease was reclaimed by another worker", async () => {
    // No renewal: worker B takes the row over mid-run, holding a long lease
    // of its own, as a reclaim after A's lease lapsed leaves it.
    h = await harness({ leaseMs: 5_000, extendLeaseWhileRunning: false });
    const id = await h.send({ mode: "sleep", ms: 150 });
    await h.worker.start();
    await waitFor(() => LeaseJob.executions === 1);
    await h.storage.finalize(id, { lease_owner: "worker-b" });
    await h.storage.extendLease(id, "worker-b", 30_000);

    await waitFor(() => h!.events.length > 0);
    await sleep(20);
    expect(h.events).toEqual(["job_lease_lost"]);
    const row = await h.storage.get(id);
    // A's COMPLETED never landed over B's claim.
    expect(row?.status).toBe(JobStatus.PROCESSING);
    expect(row?.lease_owner).toBe("worker-b");
    expect(row?.output ?? null).toBeNull();
  });

  it("does not run a job twice when its own poll loop reclaims it mid-run", async () => {
    // Without renewal the lease lapses while the job runs; this worker's poll
    // loop is the only reclaimer. The running execution takes the new claim
    // over, so the job runs once and its result lands through the new claim.
    h = await harness({ leaseMs: 30, extendLeaseWhileRunning: false });
    const id = await h.send({ mode: "sleep", ms: 200 });
    await h.worker.start();
    await waitFor(() => h!.events.length > 0);

    expect(LeaseJob.executions).toBe(1);
    expect(h.events).toEqual(["job_complete"]);
    const row = await h.storage.get(id);
    expect(row?.status).toBe(JobStatus.COMPLETED);
    expect(row?.output).toEqual({ done: true });
    // The reclaims did happen — each charged an attempt.
    expect(row?.attempts ?? 0).toBeGreaterThan(0);
  });
});
