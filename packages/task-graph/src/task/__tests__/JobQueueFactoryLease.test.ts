/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JobQueueFactoryOptions, TaskInput, TaskOutput } from "@workglow/task-graph";
import { createJobQueueFactoryWithOptions, getJobQueueFactory } from "@workglow/task-graph";
import { InMemoryQueueStorage, Job } from "@workglow/job-queue";
import { uuid4 } from "@workglow/util";
import { describe, expect, it } from "vitest";

class NoopJob extends Job<TaskInput, TaskOutput> {
  public override async execute(): Promise<TaskOutput> {
    return {};
  }
}

/** The lease settings the server will hand its workers. */
function leaseSettings(server: unknown): {
  leaseMs: number | undefined;
  extendLeaseWhileRunning: boolean | undefined;
} {
  const s = server as { leaseMs?: number; extendLeaseWhileRunning?: boolean };
  return { leaseMs: s.leaseMs, extendLeaseWhileRunning: s.extendLeaseWhileRunning };
}

async function build(
  options: JobQueueFactoryOptions<TaskInput, TaskOutput> | undefined,
  factory = getJobQueueFactory()
): Promise<ReturnType<typeof leaseSettings>> {
  const { server } = await factory({
    queueName: `factory-lease-${uuid4()}`,
    jobClass: NoopJob as any,
    options,
  });
  return leaseSettings(server);
}

describe("job queue factory lease settings", () => {
  it("renews leases by default when it builds its own in-memory storage", async () => {
    // An in-memory queue dies with its worker, so a lease there only lapses
    // under a job still running; without renewal the worker's own poll loop
    // reclaims it.
    expect(await build(undefined)).toEqual({ leaseMs: undefined, extendLeaseWhileRunning: true });
  });

  it("passes leaseMs and extendLeaseWhileRunning through", async () => {
    expect(await build({ leaseMs: 5_000, extendLeaseWhileRunning: false })).toEqual({
      leaseMs: 5_000,
      extendLeaseWhileRunning: false,
    });
  });

  it("leaves renewal to the server's default for a caller-supplied storage", async () => {
    const storage = new InMemoryQueueStorage<TaskInput, TaskOutput>(`given-${uuid4()}`);
    expect(await build({ storage })).toEqual({
      leaseMs: undefined,
      extendLeaseWhileRunning: undefined,
    });
  });

  it("applies the same defaults through createJobQueueFactoryWithOptions", async () => {
    const factory = createJobQueueFactoryWithOptions({ leaseMs: 9_000 });
    expect(await build(undefined, factory)).toEqual({
      leaseMs: 9_000,
      extendLeaseWhileRunning: true,
    });
  });
});
