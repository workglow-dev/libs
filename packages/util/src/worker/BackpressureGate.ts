/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cost-agnostic park/wake primitive for producer/consumer backpressure.
 *
 * A producer calls {@link charge} with the cost of the item it just handed to
 * a buffer; the returned promise resolves immediately while buffered cost is
 * under the high-water mark and otherwise **parks** until a consumer has
 * {@link credit}ed enough cost back to drop below the mark. {@link close} and
 * {@link fail} release every parked producer so an aborted or errored stream
 * never orphans a waiter.
 *
 * The gate owns only the accounting and the wake signal — it does not hold the
 * buffered items themselves. The "cost" unit is whatever the caller charges
 * (bytes for binary chunks, UTF-8 length for text, a per-delta unit for
 * objects), so one gate serves every stream mode.
 */
export class BackpressureGate {
  private bufferedCost = 0;
  private finished = false;
  private failureError: Error | undefined;
  /** Resolver for producer(s) parked waiting for the buffer to drain. */
  private drainNotify: (() => void) | undefined;
  private readonly highWaterMarkCost: number;

  constructor(highWaterMarkCost: number) {
    this.highWaterMarkCost = Math.max(1, highWaterMarkCost);
  }

  /**
   * Record `cost` as newly buffered and return a promise the producer must
   * await. Resolves immediately when buffered cost stays under the high-water
   * mark (or the gate is closed); otherwise parks until {@link credit},
   * {@link close}, or {@link fail} drops the gate below the mark or releases it.
   */
  charge(cost: number): Promise<void> {
    if (this.failureError) return Promise.reject(this.failureError);
    if (this.finished) return Promise.resolve();
    this.bufferedCost += cost;
    if (this.bufferedCost < this.highWaterMarkCost) return Promise.resolve();
    return this.park();
  }

  /**
   * Record `cost` as newly buffered WITHOUT returning a park promise. Used by a
   * consumer-side accountant (an edge stream) that books a buffered item while
   * the producer parks separately via {@link awaitBelowMark}. No-op once closed.
   */
  account(cost: number): void {
    if (this.finished) return;
    this.bufferedCost += cost;
  }

  /**
   * Account `cost` as consumed and, if that drops buffered cost below the mark,
   * wake every parked producer. Safe to over-credit; buffered cost floors at 0.
   */
  credit(cost: number): void {
    this.bufferedCost -= cost;
    if (this.bufferedCost < 0) this.bufferedCost = 0;
    if (this.drainNotify && this.bufferedCost < this.highWaterMarkCost) {
      this.wakeDrain();
    }
  }

  /** Close the gate: release all parked producers; later charges are no-ops. */
  close(): void {
    if (this.finished) return;
    this.finished = true;
    this.wakeDrain();
  }

  /** Fail the gate: record the error, release parked producers, close. */
  fail(err: Error): void {
    if (this.finished) return;
    this.failureError = err;
    this.finished = true;
    this.wakeDrain();
  }

  /**
   * Resolve when buffered cost is below the high-water mark (or the gate is
   * closed). Used by the cooperative `IExecuteContext.backpressure` hook so a
   * task emitting via a side channel can park until the consumer drains.
   */
  awaitBelowMark(): Promise<void> {
    if (this.failureError) return Promise.reject(this.failureError);
    if (this.finished) return Promise.resolve();
    if (this.bufferedCost < this.highWaterMarkCost) return Promise.resolve();
    return this.park();
  }

  /** True once {@link close} or {@link fail} has been called. */
  get closed(): boolean {
    return this.finished;
  }

  /** The error passed to {@link fail}, if any. */
  get failure(): Error | undefined {
    return this.failureError;
  }

  /**
   * True while buffered cost is at or above the high-water mark — the state
   * in which a producer charging (or awaiting below-mark) parks. Liveness
   * watchdogs probe this to tell a genuinely stalled (parked) producer apart
   * from an idle gate that simply has nothing buffered.
   */
  get isAboveMark(): boolean {
    return this.bufferedCost >= this.highWaterMarkCost;
  }

  /** @internal Test/observability hook: current buffered (un-credited) cost. */
  get _bufferedCost(): number {
    return this.bufferedCost;
  }

  /** @internal Test/observability hook: high-water mark in effect. */
  get _highWaterMark(): number {
    return this.highWaterMarkCost;
  }

  private park(): Promise<void> {
    return new Promise<void>((res, rej) => {
      // Chain resolvers so a credit that crosses the mark releases every
      // producer parked since the last wake, not just the most recent. A
      // fail() after the park settles here rejects — producers must see the
      // watchdog / abort error, not silently resume as if the buffer drained.
      const prev = this.drainNotify;
      this.drainNotify = prev
        ? () => {
            prev();
            if (this.failureError) rej(this.failureError);
            else res();
          }
        : () => {
            if (this.failureError) rej(this.failureError);
            else res();
          };
    });
  }

  private wakeDrain(): void {
    const n = this.drainNotify;
    this.drainNotify = undefined;
    n?.();
  }
}
