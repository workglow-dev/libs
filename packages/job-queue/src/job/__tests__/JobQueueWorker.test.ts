/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IJobExecuteContext, JobStorageFormat } from "@workglow/job-queue";
import {
  DelayLimiter,
  InMemoryQueueStorage,
  InMemoryRateLimiterStorage,
  Job,
  JobDisabledError,
  JobQueueClient,
  JobQueueServer,
  JobQueueWorker,
  JobStatus,
  PermanentJobError,
  RateLimiter,
  wrapQueueStorage,
} from "@workglow/job-queue";
import { DEFAULT_LIMITS, setLogger, sleep, uuid4 } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface TI {
  readonly taskType?: string;
  readonly data?: string;
  readonly [key: string]: unknown;
}
interface TO {
  readonly result?: string;
  readonly [key: string]: unknown;
}

/**
 * Test job that supports a few input flavours.
 * - `long_running` — hangs on a promise that only resolves when its signal fires.
 * - `disable_on_abort` — throws JobDisabledError when its signal fires (used to
 *   exercise the JobDisabledError dispatch branch in processSingleJob's catch).
 * - anything else — resolves immediately.
 */
class TJob extends Job<TI, TO> {
  public static executeCalls = 0;

  public override async execute(input: TI, context: IJobExecuteContext): Promise<TO> {
    TJob.executeCalls += 1;
    if (input.taskType === "disable_on_abort") {
      return new Promise<TO>((_, reject) => {
        context.signal.addEventListener(
          "abort",
          () => reject(new JobDisabledError(`Job ${String(input.data)} was disabled`)),
          { once: true }
        );
      });
    }
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

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  ceilingMs = 1000,
  stepMs = 5
): Promise<boolean> {
  const deadline = Date.now() + ceilingMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

describe("JobQueueWorker — PR #511 follow-up regressions", () => {
  setLogger(getTestingLogger());
  let storage: InMemoryQueueStorage<TI, TO>;
  let queueName: string;

  beforeEach(async () => {
    TJob.executeCalls = 0;
    queueName = `worker-followup-${uuid4()}`;
    storage = new InMemoryQueueStorage<TI, TO>(queueName);
    await storage.migrate();
  });

  afterEach(async () => {
    await storage.deleteAll();
  });

  it("DEADLINE-EXCEEDED job releases its RateLimiter slot", async () => {
    // Two-slot rate limiter. Without the fix, a job whose deadline_at is in
    // the past consumes one slot at tryAcquire and never returns it (the
    // outer finally calls limiter.complete(), which is a no-op for
    // RateLimiter). The fix calls limiter.release() before rethrowing
    // the validation error.
    const limiter = new RateLimiter(new InMemoryRateLimiterStorage(), queueName, {
      maxExecutions: 2,
      windowSizeInSeconds: 60,
    });

    const { messageQueue, jobStore } = wrapQueueStorage(storage);
    const server = new JobQueueServer<TI, TO, TJob>(TJob, {
      messageQueue,
      jobStore,
      queueName,
      pollIntervalMs: 5,
      stopTimeoutMs: 0,
      limiter,
    });
    const client = new JobQueueClient<TI, TO>({ messageQueue, jobStore, queueName });
    client.attach(server);

    // Insert a job whose deadline is already in the past so validateJobState
    // rejects with PermanentJobError ("has exceeded its deadline"). We use
    // storage.add directly because client.send only accepts a positive
    // timeoutSeconds.
    const pastDeadline = new Date(Date.now() - 60_000).toISOString();
    const id = await storage.add({
      input: { taskType: "deadline-exceeded", data: "x" },
      visible_at: null,
      completed_at: null,
      deadline_at: pastDeadline,
    } as any);

    await server.start();

    // Wait for the job to leave PENDING (it should fail validation and reach
    // FAILED very quickly).
    const left = await waitUntil(async () => {
      const j = await storage.get(id);
      return !!j && j.status !== JobStatus.PENDING;
    });
    expect(left).toBe(true);

    // Give the finally block a tick to run.
    await sleep(20);

    // Both slots must still be free — the failed validation must not have
    // burned a slot.
    const t1 = await limiter.tryAcquire();
    const t2 = await limiter.tryAcquire();
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();

    await limiter.release(t1);
    await limiter.release(t2);

    await server.stop();
  });

  it("disabling a job mid-flight transitions it to DISABLED, not FAILED", async () => {
    // The user task throws JobDisabledError when its abort signal fires —
    // the realistic shape of consumer code that detects disablement on
    // re-checking state. Without the JobDisabledError dispatch branch in
    // processSingleJob's catch, this error fell into the generic failJob
    // branch and clobbered status to FAILED.
    const { messageQueue, jobStore } = wrapQueueStorage(storage);
    const server = new JobQueueServer<TI, TO, TJob>(TJob, {
      messageQueue,
      jobStore,
      queueName,
      pollIntervalMs: 5,
      stopTimeoutMs: 0,
    });
    const client = new JobQueueClient<TI, TO>({ messageQueue, jobStore, queueName });
    client.attach(server);

    await server.start();

    const handle = await client.send({ taskType: "disable_on_abort", data: "disable-me" });

    // Wait for PROCESSING.
    const reached = await waitUntil(async () => {
      const j = await storage.get(handle.id);
      return j?.status === JobStatus.PROCESSING;
    });
    expect(reached).toBe(true);

    // Flag the row as DISABLED in storage and signal the worker to abort it.
    await storage.saveStatus(handle.id, JobStatus.DISABLED);
    // Restore PROCESSING so the worker's checkForAbortingJobs (which peeks
    // PROCESSING rows) observes abort_requested_at and fires the abort
    // controller — the user task then throws JobDisabledError.
    await storage.saveStatus(handle.id, JobStatus.PROCESSING);
    await storage.abort(handle.id);

    // Wait for terminal state — DISABLED.
    const disabled = await waitUntil(async () => {
      const j = await storage.get(handle.id);
      return j?.status === JobStatus.DISABLED;
    });

    await server.stop();
    expect(disabled).toBe(true);

    const final = await storage.get(handle.id);
    expect(final?.status).toBe(JobStatus.DISABLED);
  });

  it("pre-execute abort flag is observed during validateJobState", async () => {
    class PreAbortedWorker extends JobQueueWorker<TI, TO, TJob> {
      protected override createAbortController(jobId: unknown): AbortController {
        const controller = super.createAbortController(jobId);
        controller.abort();
        return controller;
      }
    }

    class PreAbortedServer extends JobQueueServer<TI, TO, TJob> {
      protected override createWorker(): JobQueueWorker<TI, TO, TJob> {
        return new PreAbortedWorker(this.jobClass, {
          messageQueue: this.messageQueue,
          jobStore: this.jobStore,
          queueName: this.queueName,
          limiter: this.limiter,
          pollIntervalMs: this.pollIntervalMs,
          stopTimeoutMs: this.stopTimeoutMs,
          deadLetter: this.deadLetter,
          prefetch: this.prefetch,
        });
      }
    }

    // Before the fix, createAbortController() ran AFTER validateJobState, so
    // aborting the controller here would have been too late to trip the
    // activeJobAbortControllers.get(...).signal.aborted branch. The worker
    // would enter execute() instead of failing during validation.
    const { messageQueue, jobStore } = wrapQueueStorage(storage);
    const server = new PreAbortedServer(TJob, {
      messageQueue,
      jobStore,
      queueName,
      pollIntervalMs: 5,
      stopTimeoutMs: 0,
    });
    const client = new JobQueueClient<TI, TO>({ messageQueue, jobStore, queueName });
    client.attach(server);

    const handle = await client.send({ taskType: "long_running", data: "pre-abort" });

    await server.start();

    const reached = await waitUntil(async () => {
      const j = await storage.get(handle.id);
      return (
        j?.status === JobStatus.FAILED ||
        j?.status === JobStatus.COMPLETED ||
        j?.status === JobStatus.DISABLED
      );
    });
    expect(reached).toBe(true);

    await server.stop();

    const final = await storage.get(handle.id);
    expect(final?.status).toBe(JobStatus.FAILED);
    expect(final?.abort_requested_at).toBeTruthy();
    expect(TJob.executeCalls).toBe(0);
  });

  it("server job_error event delivers the errorCode the worker carries", async () => {
    // The worker emits job_error(jobId, error, errorCode); the server forwards
    // errorCode to clients but historically dropped it from its OWN job_error
    // re-emit. A consumer subscribing to the server directly must still see the
    // machine-readable code.
    class FailingJob extends Job<TI, TO> {
      public override async execute(): Promise<TO> {
        throw new PermanentJobError("boom");
      }
    }

    const { messageQueue, jobStore } = wrapQueueStorage(storage);
    const server = new JobQueueServer<TI, TO, FailingJob>(FailingJob, {
      messageQueue,
      jobStore,
      queueName,
      pollIntervalMs: 5,
      stopTimeoutMs: 0,
    });
    const client = new JobQueueClient<TI, TO>({ messageQueue, jobStore, queueName });
    client.attach(server);

    const seen: { error: string; errorCode?: string }[] = [];
    server.on("job_error", (_queueName, _jobId, error, errorCode) => {
      seen.push({ error, errorCode });
    });

    await server.start();
    const handle = await client.send({ taskType: "fail", data: "x" }, { maxAttempts: 1 });

    const failed = await waitUntil(async () => {
      const j = await storage.get(handle.id);
      return j?.status === JobStatus.FAILED;
    });
    expect(failed).toBe(true);

    await server.stop();

    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]!.errorCode).toBe("PermanentJobError");
  });
});

/**
 * Storage that mirrors a backend whose round trips are slower than a short
 * deferral, and whose change feed is unavailable (Supabase realtime when it
 * isn't wired up) so the submit-time notify is the only wake path. The claim
 * attempt in an idle iteration then runs *before* a deferred job's `visible_at`
 * and the idle peek resolves *after* it.
 */
class SlowPeekStorage extends InMemoryQueueStorage<TI, TO> {
  public constructor(
    queueName: string,
    private readonly peekDelayMs: number
  ) {
    super(queueName);
  }

  public override async peek(
    status?: JobStatus,
    num?: number
  ): Promise<JobStorageFormat<TI, TO>[]> {
    const rows = await super.peek(status, num);
    await sleep(this.peekDelayMs);
    return rows;
  }

  public override subscribeToChanges(): () => void {
    throw new Error("change feed unavailable");
  }
}

describe("JobQueueWorker idle delay", () => {
  setLogger(getTestingLogger());

  it("picks up a deferred job whose visible_at elapsed during the idle peek", async () => {
    // The submit-time notify wakes the worker before the job is visible, so the
    // claim comes back empty; the idle peek then resolves after `visible_at`
    // has passed. Reading that as "nothing to do" would sleep the whole poll
    // interval (60s here) on a job that is claimable right now.
    const queueName = `idle-delay-${uuid4()}`;
    const storage = new SlowPeekStorage(queueName, 300);
    await storage.migrate();
    const { messageQueue, jobStore } = wrapQueueStorage(storage);
    const server = new JobQueueServer<TI, TO, TJob>(TJob, {
      messageQueue,
      jobStore,
      queueName,
      pollIntervalMs: 60_000,
      stopTimeoutMs: 0,
    });
    const client = new JobQueueClient<TI, TO>({ messageQueue, jobStore, queueName });
    client.attach(server);
    await server.start();

    // Let the worker settle into its idle sleep, so the submit below is what
    // wakes it rather than being latched as a pending wake.
    await sleep(600);

    const handle = await client.send(
      { taskType: "default", data: "deferred" },
      { delaySeconds: 0.2 }
    );

    const start = Date.now();
    const result = await Promise.race([
      handle.waitFor(),
      sleep(5_000).then(() => "TIMEOUT" as const),
    ]);
    expect(result).not.toBe("TIMEOUT");
    expect(Date.now() - start).toBeLessThan(5_000);

    await server.stop();
    await storage.deleteAll();
  }, 20_000);
});

describe("JobQueueWorker limit overrides", () => {
  it("caps the processing-time sample window at the configured maxProcessingTimeSamples", async () => {
    TJob.executeCalls = 0;
    const queueName = `limits-test-queue-${uuid4()}`;
    const storage = new InMemoryQueueStorage<TI, TO>(queueName);
    await storage.migrate();
    const { messageQueue, jobStore } = wrapQueueStorage(storage);
    const worker = new JobQueueWorker<TI, TO, TJob>(TJob, {
      messageQueue,
      jobStore,
      queueName,
      pollIntervalMs: 5,
      stopTimeoutMs: 0,
      maxProcessingTimeSamples: 2,
    });
    await worker.start();
    for (let i = 0; i < 3; i++) {
      await storage.add({
        input: { taskType: "default", data: `job-${i}` },
        visible_at: null,
        completed_at: null,
        deadline_at: null,
      } as any);
    }
    await waitUntil(() => TJob.executeCalls >= 3, 2000);
    await sleep(20);
    // @ts-expect-error accessing protected internal for the assertion
    expect(worker.processingTimes.length).toBeLessThanOrEqual(2);
    await worker.stop();
    await storage.deleteAll();
  });

  it("uses the DEFAULT_LIMITS.jobQueueLimiterMaxWakeMs value when limiterMaxWakeMs is not set", async () => {
    const queueName = `limits-test-queue-2-${uuid4()}`;
    const storage = new InMemoryQueueStorage<TI, TO>(queueName);
    await storage.migrate();
    const { messageQueue, jobStore } = wrapQueueStorage(storage);
    const worker = new JobQueueWorker<TI, TO, TJob>(TJob, {
      messageQueue,
      jobStore,
      queueName,
      stopTimeoutMs: 0,
    });
    // @ts-expect-error accessing protected internal for the assertion
    expect(worker.limiterMaxWakeMs).toBe(DEFAULT_LIMITS.jobQueueLimiterMaxWakeMs);
    await storage.deleteAll();
  });
});

describe("JobQueueWorker retry date validity", () => {
  // An Invalid Date passes `instanceof Date`, so it used to be accepted as the
  // job's next visible time. Its NaN then reached `claim.retry`'s
  // `delaySeconds`, where `new Date(NaN).toISOString()` throws a RangeError —
  // swallowed by rescheduleJob's own catch, leaving the claim dropped and the
  // job never rescheduled at all. The observable bug is a stranded job, not a
  // bad timestamp.
  it("falls back to the limiter time when handed an invalid retry date", async () => {
    const queueName = `retry-date-${uuid4()}`;
    const storage = new InMemoryQueueStorage<TI, TO>(queueName);
    await storage.migrate();
    const { messageQueue, jobStore } = wrapQueueStorage(storage);

    // A limiter time distinct from "now" so the fallback is unmistakable.
    const limiter = new DelayLimiter();
    const fallbackTime = new Date(Date.now() + 60_000);
    await limiter.setNextAvailableTime(fallbackTime);

    const worker = new JobQueueWorker<TI, TO, TJob>(TJob, {
      messageQueue,
      jobStore,
      queueName,
      pollIntervalMs: 5,
      stopTimeoutMs: 0,
      limiter,
    });

    const id = await storage.add({
      input: { taskType: "default", data: "x" },
      visible_at: null,
      completed_at: null,
      deadline_at: null,
    } as any);

    const claims = await messageQueue.receive({ workerId: "test-worker", leaseMs: 30_000, max: 1 });
    expect(claims.length).toBe(1);
    const claim = claims[0]!;

    const retryDelays: (number | undefined)[] = [];
    const originalRetry = claim.retry.bind(claim);
    (claim as { retry: (opts?: { delaySeconds?: number }) => Promise<void> }).retry = async (
      opts
    ) => {
      retryDelays.push(opts?.delaySeconds);
      await originalRetry(opts);
    };

    const job = new TJob({ queueName, input: { taskType: "default", data: "x" }, id: claim.id });
    // @ts-expect-error reaching the private claim registry the worker settles through
    worker.activeClaims.set(claim.id, claim);

    // @ts-expect-error rescheduleJob is protected; the invalid date is the point
    await worker.rescheduleJob(job, new Date(NaN));

    expect(retryDelays.length).toBe(1);
    expect(Number.isFinite(retryDelays[0]!)).toBe(true);
    expect(job.visibleAt.getTime()).toBe(fallbackTime.getTime());

    const row = await storage.get(claim.id as any);
    expect(row?.status).toBe(JobStatus.PENDING);
    expect(Number.isFinite(Date.parse(String(row?.visible_at)))).toBe(true);

    await storage.deleteAll();
  });
});
