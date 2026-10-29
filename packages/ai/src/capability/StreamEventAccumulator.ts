/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StreamEvent, TaskOutput, Usage } from "@workglow/task-graph";
import {
  mergeUsage,
  REFUSAL_CATEGORY_OUTPUT_KEY,
  REFUSAL_OUTPUT_KEY,
  retractText,
  USAGE_OUTPUT_KEY,
} from "@workglow/task-graph";

const isNonEmptyObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0;

/**
 * Stateful accumulator that materialises a single output `T` from a sequence
 * of {@link StreamEvent}s.
 *
 * - `text-delta` per port → concatenated per port (`Map<port, string>`).
 * - `text-retract` per port → the port's text loses its last `length` chars.
 * - `object-delta` non-array → replace semantics (each delta is a more
 *   complete partial snapshot — last wins per port).
 * - `object-delta` array → upsert by `id` per port.
 * - `snapshot` → replace running state (last snapshot wins).
 * - `phase` → ignored (metadata only).
 * - `error` → throws immediately at observe time.
 * - `finish` → captured separately via {@link observeFinish}; mandatory before
 *   {@link materialize}.
 *
 * Text and object deltas on DISTINCT ports coexist and compose into one object
 * (e.g. tool-calling streams text on `text` and tool calls on `toolCalls`);
 * accumulated deltas take precedence over the finish payload, mirroring the
 * task-graph StreamProcessor so `.run()` and streaming produce identical output.
 *
 * This accumulator is **only** instantiated at explicit terminal-consumer
 * sites (AiTask.execute, StreamProcessor `ctx.shouldAccumulate` branch). Do
 * not use it inside run-fns, workers, AiJob, strategies, or dataflow nodes —
 * streams in this codebase can be conceptually unbounded.
 */
/**
 * Discriminating tag attached to the error thrown by
 * {@link StreamEventAccumulator.materialize} when the underlying stream
 * ended (cleanly or otherwise) without ever emitting a `finish` event.
 * Callers (notably `AiTask.execute`) re-throw with this code preserved so
 * upstream code can distinguish "provider produced no terminal event" from
 * other provider failures.
 */
export const ACCUMULATOR_NO_FINISH = "ACCUMULATOR_NO_FINISH" as const;

export class StreamEventAccumulator<T extends TaskOutput = TaskOutput> {
  private readonly textAccumulator = new Map<string, string>();
  private readonly objectAccumulator = new Map<string, Record<string, unknown> | unknown[]>();
  private hasTextDeltas = false;
  private hasObjectDeltas = false;
  private hasSnapshots = false;
  private snapshotAccumulator: T | undefined;
  private finished = false;
  private finishData: T | undefined;
  private refusalText = "";
  private refusalCategory: string | undefined;
  // Mirrors StreamProcessor: `usage` events are cumulative snapshots of the
  // in-flight call, so they replace; `finish` states the call total and settles.
  // Mirrored down to the estimate guard — a snapshot flagged `estimated` is a
  // character-count guess kept for live display, so it is never promoted into
  // the settled total the run reports as its spend.
  private settledUsage: Usage | undefined;
  private liveUsage: Usage | undefined;
  /**
   * The `type` of the most recent observed event. Surfaced in the
   * no-finish materialise error so operators can see what the stream
   * trailed off with (e.g. `text-delta`, `phase`, `undefined`).
   */
  private lastEventType: string | undefined;

  observe(event: StreamEvent<T>): void {
    switch (event.type) {
      case "text-delta": {
        this.hasTextDeltas = true;
        this.lastEventType = "text-delta";
        const e = event as Extract<StreamEvent<T>, { type: "text-delta" }>;
        this.textAccumulator.set(e.port, (this.textAccumulator.get(e.port) ?? "") + e.textDelta);
        return;
      }
      case "text-retract": {
        this.hasTextDeltas = true;
        this.lastEventType = "text-retract";
        const e = event as Extract<StreamEvent<T>, { type: "text-retract" }>;
        const text = this.textAccumulator.get(e.port);
        if (text !== undefined) this.textAccumulator.set(e.port, retractText(text, e.length));
        return;
      }
      case "object-delta": {
        this.hasObjectDeltas = true;
        this.lastEventType = "object-delta";
        const e = event as Extract<StreamEvent<T>, { type: "object-delta" }>;
        const delta = e.objectDelta;
        if (Array.isArray(delta)) {
          const existing = this.objectAccumulator.get(e.port);
          const arr: unknown[] = Array.isArray(existing) ? [...existing] : [];
          for (const item of delta) {
            const itemObj = item as Record<string, unknown>;
            if (itemObj && typeof itemObj === "object" && "id" in itemObj) {
              const idx = arr.findIndex((ex) => (ex as Record<string, unknown>).id === itemObj.id);
              if (idx >= 0) arr[idx] = item;
              else arr.push(item);
            } else {
              arr.push(item);
            }
          }
          this.objectAccumulator.set(e.port, arr);
        } else {
          this.objectAccumulator.set(e.port, delta as Record<string, unknown>);
        }
        return;
      }
      case "snapshot": {
        this.hasSnapshots = true;
        this.lastEventType = "snapshot";
        this.snapshotAccumulator = (event as { data: T }).data;
        return;
      }
      case "phase":
        this.lastEventType = "phase";
        return;
      case "refusal": {
        // A refusal is a valid outcome (not an error): accumulate it and surface
        // it via the reserved `refusal` field in materialize().
        this.lastEventType = "refusal";
        const e = event as Extract<StreamEvent<T>, { type: "refusal" }>;
        this.refusalText += e.refusal;
        if (e.category) this.refusalCategory = e.category;
        return;
      }
      case "error":
        this.lastEventType = "error";
        throw (event as { error: unknown }).error;
      case "usage":
        this.liveUsage = (event as Extract<StreamEvent, { type: "usage" }>).usage;
        return;
      case "finish":
        this.observeFinish(event as Extract<StreamEvent<T>, { type: "finish" }>);
        return;
    }
  }

  observeFinish(event: Extract<StreamEvent<T>, { type: "finish" }>): void {
    this.finished = true;
    this.finishData = event.data;
    // Merged rather than replaced: a consumer driving several finishes through
    // one accumulator (a tool-calling loop) is billed for every turn.
    // `?? promotable` keeps a provider that emitted snapshots but no finish
    // usage — unless that snapshot is a character-count estimate, which is
    // display feedback and must not settle as this run's spend.
    const promotable = this.liveUsage?.estimated ? undefined : this.liveUsage;
    this.settledUsage = mergeUsage(this.settledUsage, event.usage ?? promotable);
    this.liveUsage = undefined;
    this.lastEventType = "finish";
  }

  materialize(): T {
    if (!this.finished) {
      const lastEventType = this.lastEventType ?? "(none)";
      const err = new Error(
        `StreamEventAccumulator: stream ended without a finish event ` +
          `(lastEventType=${lastEventType}).`
      ) as Error & { code?: string; lastEventType?: string };
      err.code = ACCUMULATOR_NO_FINISH;
      err.lastEventType = lastEventType;
      throw err;
    }
    // One-shot: finish carries the complete payload.
    if (!this.hasTextDeltas && !this.hasObjectDeltas && !this.hasSnapshots) {
      if (isNonEmptyObject(this.finishData)) return this.finalize(this.finishData);
      return this.finalize(this.finishData as unknown as T);
    }

    // Snapshot (replace) mode — last snapshot wins, finish merged on top.
    if (this.hasSnapshots && !this.hasTextDeltas && !this.hasObjectDeltas) {
      if (isNonEmptyObject(this.finishData)) {
        return this.finalize({
          ...(this.snapshotAccumulator as object),
          ...(this.finishData as object),
        } as T);
      }
      return this.finalize(this.snapshotAccumulator as T);
    }

    // Delta mode — text and/or object deltas. Accumulated deltas take precedence
    // over the finish payload, so a streaming finish (empty `{}` or a structural
    // default scaffold like `{ text: "", toolCalls: [] }`) can never clobber
    // streamed content. Text and object deltas on DISTINCT ports compose (e.g.
    // tool-calling streams text on `text` and tool calls on `toolCalls`); a
    // same-port collision resolves object-last. Mirrors the task-graph
    // StreamProcessor so `.run()` and streaming produce identical output.
    const fd = this.finishData;
    const result: Record<string, unknown> =
      fd !== null && typeof fd === "object" && !Array.isArray(fd)
        ? { ...(fd as Record<string, unknown>) }
        : {};
    for (const [port, text] of this.textAccumulator) {
      if (text.length > 0) result[port] = text;
    }
    for (const [port, obj] of this.objectAccumulator) {
      result[port] = obj;
    }
    return this.finalize(result as unknown as T);
  }

  /**
   * Applies every reserved output field to a materialised value. Usage is
   * folded last so a refused turn still reports the tokens it was billed for —
   * {@link applyRefusal} returns early when nothing was refused.
   */
  private finalize(output: T): T {
    return this.applyUsage(this.applyRefusal(output));
  }

  /**
   * Folds accumulated token counts into the reserved `usage` output field.
   * No-op when no provider reported usage, so the key is absent rather than
   * present-and-empty.
   *
   * A still-live snapshot is reachable when a provider emits usage AFTER the
   * finish it belongs to (a tool-calling loop whose last turn never finished).
   * It is folded in for the same reason the finish path folds one — but an
   * estimate is a guess, so it is dropped rather than reported as spend.
   */
  private applyUsage(output: T): T {
    const promotable = this.liveUsage?.estimated ? undefined : this.liveUsage;
    const usage = mergeUsage(this.settledUsage, promotable);
    if (!usage) return output;
    const base = (output !== null && typeof output === "object" ? output : {}) as Record<
      string,
      unknown
    >;
    return { ...base, [USAGE_OUTPUT_KEY]: usage } as unknown as T;
  }

  /**
   * Folds an accumulated refusal into the reserved `refusal` output field so
   * programmatic consumers can detect it. No-op when no refusal was observed.
   */
  private applyRefusal(output: T): T {
    if (!this.refusalText) return output;
    const base = (output !== null && typeof output === "object" ? output : {}) as Record<
      string,
      unknown
    >;
    return {
      ...base,
      [REFUSAL_OUTPUT_KEY]: this.refusalText,
      ...(this.refusalCategory ? { [REFUSAL_CATEGORY_OUTPUT_KEY]: this.refusalCategory } : {}),
    } as unknown as T;
  }
}
