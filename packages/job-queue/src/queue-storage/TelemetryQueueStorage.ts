/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { traced } from "@workglow/util";
import type { StreamChunkRow, StreamEventLike } from "../job/JobQueueEventListeners";
import type {
  IQueueStorage,
  JobStatus,
  JobStorageFormat,
  QueueChangePayload,
  QueueStorageScope,
  QueueSubscribeOptions,
} from "./IQueueStorage";

/**
 * Telemetry wrapper for any IQueueStorage implementation.
 * Creates spans for all queue storage operations.
 */
export class TelemetryQueueStorage<Input, Output> implements IQueueStorage<Input, Output> {
  constructor(
    private readonly storageName: string,
    private readonly inner: IQueueStorage<Input, Output>
  ) {
    // findActiveByFingerprint and the single-statement fast paths are
    // OPTIONAL members of IQueueStorage. Only expose each when the inner
    // storage actually implements it, so wrapQueueStorage's presence probes
    // still fall through to their generic compositions when the inner has no
    // native impl. A telemetry decorator must be transparent: always defining
    // a method would force the O(1) native path to be reported as present
    // even for backends (in-memory, IndexedDB) that lack it, then throw when
    // delegating to undefined.
    if (typeof inner.findActiveByFingerprint === "function") {
      this.findActiveByFingerprint = (fingerprint: string, queueName: string) =>
        traced("workglow.storage.queue.findActiveByFingerprint", this.storageName, () =>
          this.inner.findActiveByFingerprint!(fingerprint, queueName)
        );
    }
    // The stream-channel methods are OPTIONAL, capability-probed the same way
    // (`typeof storage.subscribeToStream === "function"`). Forward them only
    // when present so the decorator stays transparent — otherwise a
    // telemetry-wrapped channel-capable storage would lose `onStream`. Plain
    // forwards (like subscribeToChanges): publishStreamChunk is per-delta hot,
    // so it is not wrapped in a span.
    if (typeof inner.publishStreamChunk === "function") {
      this.publishStreamChunk = (jobId, event) => this.inner.publishStreamChunk!(jobId, event);
    }
    if (typeof inner.subscribeToStream === "function") {
      this.subscribeToStream = (jobId, sinceSeq, callback) =>
        this.inner.subscribeToStream!(jobId, sinceSeq, callback);
    }
    if (typeof inner.saveStatus === "function") {
      this.saveStatus = (id: unknown, status: JobStatus) =>
        traced("workglow.storage.queue.saveStatus", this.storageName, async () =>
          this.inner.saveStatus!(id, status)
        );
    }
    if (typeof inner.getMany === "function") {
      this.getMany = (ids: readonly unknown[]) =>
        traced("workglow.storage.queue.getMany", this.storageName, () => this.inner.getMany!(ids));
    }
    if (typeof inner.completeWithResult === "function") {
      this.completeWithResult = (id: unknown, result: Output) =>
        traced("workglow.storage.queue.completeWithResult", this.storageName, () =>
          this.inner.completeWithResult!(id, result)
        );
    }
    if (typeof inner.failWithError === "function") {
      this.failWithError = (
        id: unknown,
        opts: {
          readonly error?: string | null;
          readonly errorCode?: string | null;
          readonly abortRequested?: boolean;
        }
      ) =>
        traced("workglow.storage.queue.failWithError", this.storageName, () =>
          this.inner.failWithError!(id, opts)
        );
    }
  }

  public get scope(): QueueStorageScope {
    return this.inner.scope;
  }

  public get queueName(): string | undefined {
    return this.inner.queueName;
  }

  public get durable(): boolean | undefined {
    return this.inner.durable;
  }

  /**
   * Conditionally assigned in the constructor — present only when the inner
   * storage exposes a native implementation. See the constructor for why these
   * mirror the inner's presence rather than always defining the methods.
   */
  public readonly findActiveByFingerprint?: (
    fingerprint: string,
    queueName: string
  ) => Promise<JobStorageFormat<Input, Output> | undefined>;
  public readonly saveStatus?: (id: unknown, status: JobStatus) => void | Promise<void>;
  public readonly getMany?: (
    ids: readonly unknown[]
  ) => Promise<ReadonlyArray<JobStorageFormat<Input, Output> | undefined>>;
  public readonly completeWithResult?: (id: unknown, result: Output) => Promise<void>;
  public readonly failWithError?: (
    id: unknown,
    opts: {
      readonly error?: string | null;
      readonly errorCode?: string | null;
      readonly abortRequested?: boolean;
    }
  ) => Promise<void>;

  /** Conditionally assigned in the constructor — mirrors the inner's presence. */
  public readonly publishStreamChunk?: (jobId: unknown, event: StreamEventLike) => Promise<void>;

  /** Conditionally assigned in the constructor — mirrors the inner's presence. */
  public readonly subscribeToStream?: (
    jobId: unknown,
    sinceSeq: number,
    callback: (row: StreamChunkRow) => unknown
  ) => () => void;

  add(job: JobStorageFormat<Input, Output>): Promise<unknown> {
    return traced("workglow.storage.queue.add", this.storageName, () => this.inner.add(job));
  }
  get(id: unknown): Promise<JobStorageFormat<Input, Output> | undefined> {
    return traced("workglow.storage.queue.get", this.storageName, () => this.inner.get(id));
  }
  next(
    workerId: string,
    opts?: { leaseMs?: number }
  ): Promise<JobStorageFormat<Input, Output> | undefined> {
    return traced("workglow.storage.queue.next", this.storageName, () =>
      this.inner.next(workerId, opts)
    );
  }
  extendLease(id: unknown, workerId: string, ms: number): Promise<void> {
    return traced("workglow.storage.queue.extendLease", this.storageName, () =>
      this.inner.extendLease(id, workerId, ms)
    );
  }
  peek(status?: JobStatus, num?: number): Promise<Array<JobStorageFormat<Input, Output>>> {
    return traced("workglow.storage.queue.peek", this.storageName, () =>
      this.inner.peek(status, num)
    );
  }
  size(status?: JobStatus): Promise<number> {
    return traced("workglow.storage.queue.size", this.storageName, () => this.inner.size(status));
  }
  complete(job: JobStorageFormat<Input, Output>): Promise<void> {
    return traced("workglow.storage.queue.complete", this.storageName, () =>
      this.inner.complete(job)
    );
  }
  // Derive `fields` directly from IQueueStorage so future additions to
  // finalize (e.g. visible_at for markEnqueueDeferred) don't require
  // re-listing every field here — callers using the concrete wrapper type
  // would otherwise get excess-property errors any time the interface grew.
  finalize(
    id: unknown,
    fields: Parameters<IQueueStorage<Input, Output>["finalize"]>[1]
  ): Promise<void> {
    return traced("workglow.storage.queue.finalize", this.storageName, () =>
      this.inner.finalize(id, fields)
    );
  }
  markDisabled(id: unknown): Promise<void> {
    return traced("workglow.storage.queue.markDisabled", this.storageName, () =>
      this.inner.markDisabled(id)
    );
  }
  releaseClaim(id: unknown): Promise<void> {
    return traced("workglow.storage.queue.releaseClaim", this.storageName, () =>
      this.inner.releaseClaim(id)
    );
  }
  deleteAll(): Promise<void> {
    return traced("workglow.storage.queue.deleteAll", this.storageName, () =>
      this.inner.deleteAll()
    );
  }
  outputForInput(input: Input): Promise<Output | null> {
    return traced("workglow.storage.queue.outputForInput", this.storageName, () =>
      this.inner.outputForInput(input)
    );
  }
  abort(id: unknown): Promise<void> {
    return traced("workglow.storage.queue.abort", this.storageName, () => this.inner.abort(id));
  }
  getByRunId(runId: string): Promise<Array<JobStorageFormat<Input, Output>>> {
    return traced("workglow.storage.queue.getByRunId", this.storageName, () =>
      this.inner.getByRunId(runId)
    );
  }
  saveProgress(
    id: unknown,
    progress: number,
    message: string,
    details: Record<string, any> | null
  ): Promise<void> {
    return traced("workglow.storage.queue.saveProgress", this.storageName, () =>
      this.inner.saveProgress(id, progress, message, details)
    );
  }
  delete(id: unknown): Promise<void> {
    return traced("workglow.storage.queue.delete", this.storageName, () => this.inner.delete(id));
  }
  deleteJobsByStatusAndAge(status: JobStatus, olderThanMs: number): Promise<void> {
    return traced("workglow.storage.queue.deleteJobsByStatusAndAge", this.storageName, () =>
      this.inner.deleteJobsByStatusAndAge(status, olderThanMs)
    );
  }
  migrate(): Promise<void> {
    return this.inner.migrate();
  }
  getMigrations(): ReadonlyArray<unknown> {
    return this.inner.getMigrations();
  }
  subscribeToChanges(
    callback: (change: QueueChangePayload<Input, Output>) => void,
    options?: QueueSubscribeOptions
  ): () => void {
    return this.inner.subscribeToChanges(callback, options);
  }
}
