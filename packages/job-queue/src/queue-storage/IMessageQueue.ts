/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StreamChunkRow, StreamEventLike } from "../job/JobQueueEventListeners";
import type { IClaim } from "./IClaim";
import type { QueueChangePayload, QueueStorageScope, QueueSubscribeOptions } from "./IQueueStorage";

export type MessageId = unknown;

/**
 * Options for sending a message to the queue.
 */
export interface SendOptions {
  readonly delaySeconds?: number;
  readonly timeoutSeconds?: number;
  readonly fingerprint?: string;
  readonly jobRunId?: string;
  readonly maxAttempts?: number;
}

/**
 * Message queue interface — owns producing and consuming messages.
 * Pairs with {@link IJobStore} for read-side / mutation access to the
 * stored job record.
 */
export interface IMessageQueue<Body> {
  readonly scope: QueueStorageScope;
  send(body: Body, opts?: SendOptions): Promise<MessageId>;
  /**
   * Enqueue a batch of bodies.
   *
   * `opts.fingerprint` is REJECTED by adapters that participate in
   * fingerprint deduplication (SQS, Cloudflare Queues): applying a single
   * fingerprint to N distinct bodies would dedup every body against the
   * first row, returning the same id N times. If you need fingerprinted
   * dedup, call {@link send} per body so each call can carry its own
   * fingerprint. Other options (`delaySeconds`, `timeoutSeconds`,
   * `jobRunId`, `maxAttempts`) apply uniformly to every body in the batch.
   */
  sendBatch(bodies: readonly Body[], opts?: SendOptions): Promise<readonly MessageId[]>;
  receive(opts: {
    workerId: string;
    leaseMs: number;
    max?: number;
  }): Promise<readonly IClaim<Body>[]>;
  releaseClaim(id: MessageId): Promise<void>;
  migrate(): Promise<void>;
  getMigrations(): ReadonlyArray<unknown>;
  subscribeToChanges?(
    callback: (change: QueueChangePayload<any, any>) => void,
    options?: QueueSubscribeOptions
  ): () => void;
  /**
   * OPTIONAL — append a live stream event to job `jobId`'s ordered side-stream.
   * Present only on carriers that can fan a job's stream out of process. The
   * CARRIER assigns the monotonic 1-based `seq` (returned on each row) from a
   * per-job counter it owns, so the sequence is correct across workers — a
   * retry claimed by a different worker continues the same job's sequence
   * instead of restarting at 1 and colliding with the prior attempt. Absent on
   * pull-only backends.
   */
  publishStreamChunk?(jobId: unknown, event: StreamEventLike): Promise<void>;
  /**
   * OPTIONAL — subscribe to a job's stream side-stream. Any already-published
   * rows with `seq > sinceSeq` are replayed before live delivery (the
   * reconnect-gap story). Returns an unsubscribe function.
   *
   * A carrier that delivers SYNCHRONOUSLY from a live producer — an
   * in-process one, whose publish runs inside the emitting job's own awaited
   * dispatch — must await what `callback` returns, so the consumer paces the
   * producer. Without that the producer is paced only by the append and a
   * slow consumer's queue grows with the whole stream. A carrier replaying
   * rows published earlier has no producer to pace and may ignore it.
   */
  subscribeToStream?(
    jobId: unknown,
    sinceSeq: number,
    callback: (row: StreamChunkRow) => void | Promise<void>
  ): () => void;
}
