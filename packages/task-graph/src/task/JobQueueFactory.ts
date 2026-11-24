/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  IQueueStorage,
  Job,
  JobConstructorParam,
  JobQueueServerOptions,
} from "@workglow/job-queue";
import {
  InMemoryQueueStorage,
  JobQueueClient,
  JobQueueServer,
  wrapQueueStorage,
} from "@workglow/job-queue";
import { createServiceToken, globalServiceRegistry } from "@workglow/util";
import type { RegisteredQueue } from "./TaskQueueRegistry";
import type { TaskConfig, TaskInput, TaskOutput } from "./TaskTypes";

export type JobClassConstructor<Input extends TaskInput, Output extends TaskOutput> = new (
  params: JobConstructorParam<Input, Output>
) => Job<Input, Output>;

/**
 * Options for creating a job queue via the factory
 */
export interface JobQueueFactoryOptions<Input, Output> {
  readonly storage?: IQueueStorage<Input, Output>;
  readonly limiter?: JobQueueServerOptions<Input, Output>["limiter"];
  readonly workerCount?: number;
  readonly pollIntervalMs?: number;
  readonly deleteAfterCompletionMs?: number;
  readonly deleteAfterFailureMs?: number;
  readonly deleteAfterDisabledMs?: number;
  readonly cleanupIntervalMs?: number;
  readonly stopTimeoutMs?: number;
  /** Passed to the server; see `JobQueueServerOptions.leaseMs`. */
  readonly leaseMs?: number;
  /**
   * Passed to the server; see `JobQueueServerOptions.extendLeaseWhileRunning`.
   * Defaults to `true` when the factory builds its own in-memory storage (no
   * `storage` given) and to the server's default otherwise. An in-memory queue
   * dies with its worker, so a lease there only ever expires under a job that
   * is still running — and the worker's own poll loop then reclaims it.
   */
  readonly extendLeaseWhileRunning?: boolean;
}

export interface JobQueueFactoryParams<Input extends TaskInput, Output extends TaskOutput> {
  readonly queueName: string;
  readonly jobClass: JobClassConstructor<Input, Output>;
  readonly input?: Input;
  readonly config?: TaskConfig;
  readonly task?: unknown;
  readonly options?: JobQueueFactoryOptions<Input, Output>;
}

export type JobQueueFactory = <Input extends TaskInput, Output extends TaskOutput>(
  params: JobQueueFactoryParams<Input, Output>
) => Promise<RegisteredQueue<Input, Output>> | RegisteredQueue<Input, Output>;

export const JOB_QUEUE_FACTORY = createServiceToken<JobQueueFactory>("taskgraph.jobQueueFactory");

/**
 * Build the storage, server and client one factory call returns. Shared by
 * the default factory and {@link createJobQueueFactoryWithOptions} so the two
 * cannot drift on which options reach the server.
 */
async function buildRegisteredQueue<Input extends TaskInput, Output extends TaskOutput>(
  queueName: string,
  jobClass: JobClassConstructor<Input, Output>,
  options: JobQueueFactoryOptions<Input, Output> | undefined
): Promise<RegisteredQueue<Input, Output>> {
  const ownsStorage = options?.storage === undefined;
  const storage =
    (options?.storage as IQueueStorage<Input, Output> | undefined) ??
    new InMemoryQueueStorage<Input, Output>(queueName);
  await storage.migrate();
  const { messageQueue, jobStore } = wrapQueueStorage(storage);

  const server = new JobQueueServer<Input, Output>(jobClass as JobClassConstructor<any, any>, {
    messageQueue,
    jobStore,
    queueName,
    limiter: options?.limiter,
    workerCount: options?.workerCount,
    pollIntervalMs: options?.pollIntervalMs,
    deleteAfterCompletionMs: options?.deleteAfterCompletionMs,
    deleteAfterFailureMs: options?.deleteAfterFailureMs,
    deleteAfterDisabledMs: options?.deleteAfterDisabledMs,
    cleanupIntervalMs: options?.cleanupIntervalMs,
    stopTimeoutMs: options?.stopTimeoutMs,
    leaseMs: options?.leaseMs,
    extendLeaseWhileRunning: options?.extendLeaseWhileRunning ?? (ownsStorage ? true : undefined),
  });

  const client = new JobQueueClient<Input, Output>({
    messageQueue,
    jobStore,
    queueName,
  });

  // Attach client to server for same-process optimization
  client.attach(server);

  return { server, client, storage };
}

const defaultJobQueueFactory: JobQueueFactory = async <
  Input extends TaskInput,
  Output extends TaskOutput,
>({
  queueName,
  jobClass,
  options,
}: JobQueueFactoryParams<Input, Output>): Promise<RegisteredQueue<Input, Output>> =>
  buildRegisteredQueue(queueName, jobClass, options);

export function registerJobQueueFactory(factory: JobQueueFactory): void {
  globalServiceRegistry.registerInstance(JOB_QUEUE_FACTORY, factory);
}

/**
 * Creates a job queue factory from server options
 */
export function createJobQueueFactoryWithOptions(
  defaultOptions: Partial<JobQueueFactoryOptions<unknown, unknown>> = {}
): JobQueueFactory {
  return async <Input extends TaskInput, Output extends TaskOutput>({
    queueName,
    jobClass,
    options,
  }: JobQueueFactoryParams<Input, Output>): Promise<RegisteredQueue<Input, Output>> => {
    const mergedOptions = {
      ...defaultOptions,
      ...(options ?? {}),
    } as JobQueueFactoryOptions<Input, Output>;
    return buildRegisteredQueue(queueName, jobClass, mergedOptions);
  };
}

export function getJobQueueFactory(): JobQueueFactory {
  if (!globalServiceRegistry.has(JOB_QUEUE_FACTORY)) {
    registerJobQueueFactory(defaultJobQueueFactory);
  }
  return globalServiceRegistry.get(JOB_QUEUE_FACTORY);
}

if (!globalServiceRegistry.has(JOB_QUEUE_FACTORY)) {
  registerJobQueueFactory(defaultJobQueueFactory);
}
