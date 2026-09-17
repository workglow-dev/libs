/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { StreamEventAccumulator } from "@workglow/ai";
import type { StreamEvent, Usage } from "@workglow/task-graph";
import { mergeUsage } from "@workglow/task-graph";
import { describe, expect, it } from "vitest";

/** Builds a {@link Usage} with every unstated counter explicitly unreported. */
function usage(partial: Partial<Usage>): Usage {
  return {
    input: undefined,
    output: undefined,
    cached: undefined,
    cacheWrite: undefined,
    reasoning: undefined,
    total: undefined,
    extra: undefined,
    ...partial,
  };
}

interface Out {
  text?: string;
  count?: number;
  items?: unknown[];
  [key: string]: unknown;
}

describe("StreamEventAccumulator", () => {
  it("returns finish data verbatim when no deltas observed (one-shot)", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observeFinish({ type: "finish", data: { count: 42 } });
    expect(acc.materialize()).toEqual({ count: 42 });
  });

  it("concatenates text-delta per port", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observe({ type: "text-delta", port: "text", textDelta: "Hel" } as StreamEvent<Out>);
    acc.observe({ type: "text-delta", port: "text", textDelta: "lo" } as StreamEvent<Out>);
    acc.observeFinish({ type: "finish", data: {} });
    expect(acc.materialize()).toEqual({ text: "Hello" });
  });

  it("replaces object-delta non-array payloads (latest wins)", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observe({ type: "object-delta", port: "obj", objectDelta: { a: 1 } } as StreamEvent<Out>);
    acc.observe({
      type: "object-delta",
      port: "obj",
      objectDelta: { a: 1, b: 2 },
    } as StreamEvent<Out>);
    acc.observeFinish({ type: "finish", data: {} });
    expect(acc.materialize()).toEqual({ obj: { a: 1, b: 2 } });
  });

  it("upserts array object-delta items by id", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observe({
      type: "object-delta",
      port: "items",
      objectDelta: [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
    } as StreamEvent<Out>);
    acc.observe({
      type: "object-delta",
      port: "items",
      objectDelta: [{ id: 1, name: "A" }],
    } as StreamEvent<Out>);
    acc.observeFinish({ type: "finish", data: {} });
    expect(acc.materialize()).toEqual({
      items: [
        { id: 1, name: "A" },
        { id: 2, name: "b" },
      ],
    });
  });

  it("composes text-delta and object-delta on distinct ports", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observe({ type: "text-delta", port: "text", textDelta: "x" } as StreamEvent<Out>);
    acc.observe({ type: "object-delta", port: "obj", objectDelta: { a: 1 } } as StreamEvent<Out>);
    acc.observeFinish({ type: "finish", data: {} });
    expect(acc.materialize()).toEqual({ text: "x", obj: { a: 1 } });
  });

  it("accumulated deltas win over a structural finish scaffold (no clobber)", () => {
    // A tool-calling run-fn streams tool calls as object-delta then emits a
    // structural default scaffold on finish. The streamed calls must survive,
    // and the absent `text` port falls back to the scaffold default.
    const acc = new StreamEventAccumulator<Out>();
    acc.observe({
      type: "object-delta",
      port: "toolCalls",
      objectDelta: [{ id: "call_0", name: "search", input: {} }],
    } as StreamEvent<Out>);
    acc.observeFinish({ type: "finish", data: { text: "", toolCalls: [] } });
    expect(acc.materialize()).toEqual({
      text: "",
      toolCalls: [{ id: "call_0", name: "search", input: {} }],
    });
  });

  it("throws on error event", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observe({ type: "text-delta", port: "text", textDelta: "x" } as StreamEvent<Out>);
    expect(() =>
      acc.observe({ type: "error", error: new Error("boom") } as StreamEvent<Out>)
    ).toThrow(/boom/);
  });

  it("ignores phase events", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observe({ type: "phase", message: "Loading", progress: 0.5 } as StreamEvent<Out>);
    acc.observeFinish({ type: "finish", data: { count: 1 } });
    expect(acc.materialize()).toEqual({ count: 1 });
  });

  it("throws when no finish was observed", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observe({ type: "text-delta", port: "text", textDelta: "x" } as StreamEvent<Out>);
    expect(() => acc.materialize()).toThrow(/finish/i);
  });

  it("tags no-finish failures with ACCUMULATOR_NO_FINISH code and lastEventType", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observe({ type: "text-delta", port: "text", textDelta: "x" } as StreamEvent<Out>);
    acc.observe({ type: "phase", message: "hi", progress: 0.1 } as StreamEvent<Out>);
    let caught: unknown;
    try {
      acc.materialize();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const err = caught as { code?: string; lastEventType?: string; message?: string };
    expect(err.code).toBe("ACCUMULATOR_NO_FINISH");
    expect(err.lastEventType).toBe("phase");
    expect(err.message).toMatch(/lastEventType=phase/);
  });

  it("folds refusal deltas into the reserved refusal field (one-shot finish)", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observe({ type: "refusal", refusal: "I can't " } as StreamEvent<Out>);
    acc.observe({ type: "refusal", refusal: "help with that." } as StreamEvent<Out>);
    acc.observeFinish({ type: "finish", data: {} });
    expect(acc.materialize()).toEqual({ refusal: "I can't help with that." });
  });

  it("carries refusal alongside accumulated text and a category", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observe({ type: "text-delta", port: "text", textDelta: "partial" } as StreamEvent<Out>);
    acc.observe({
      type: "refusal",
      refusal: "declined",
      category: "output-refusal",
    } as StreamEvent<Out>);
    acc.observeFinish({ type: "finish", data: {} });
    expect(acc.materialize()).toEqual({
      text: "partial",
      refusal: "declined",
      refusalCategory: "output-refusal",
    });
  });

  it("does not add a refusal field when no refusal was observed", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observe({ type: "text-delta", port: "text", textDelta: "hi" } as StreamEvent<Out>);
    acc.observeFinish({ type: "finish", data: {} });
    expect(acc.materialize()).toEqual({ text: "hi" });
  });

  it("surfaces finish usage on the reserved usage field (one-shot finish)", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observeFinish({
      type: "finish",
      data: { count: 1 },
      usage: usage({ input: 10, output: 4 }),
    });
    const result = acc.materialize();
    expect(result.count).toBe(1);
    expect(result.usage).toEqual(usage({ input: 10, output: 4 }));
  });

  it("keeps one-shot finish data as the payload when usage rides alongside", () => {
    // The one-shot convention says finish.data IS the Output. A usage sibling
    // must not displace or reshape it.
    const acc = new StreamEventAccumulator<Out>();
    acc.observeFinish({
      type: "finish",
      data: { count: 42, items: [1, 2] },
      usage: usage({ input: 7 }),
    });
    const result = acc.materialize();
    expect(result.count).toBe(42);
    expect(result.items).toEqual([1, 2]);
    expect(result.usage).toEqual(usage({ input: 7 }));
  });

  it("keeps accumulated deltas winning when usage rides on the finish", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observe({ type: "text-delta", port: "text", textDelta: "Hel" } as StreamEvent<Out>);
    acc.observe({ type: "text-delta", port: "text", textDelta: "lo" } as StreamEvent<Out>);
    acc.observeFinish({ type: "finish", data: { text: "" }, usage: usage({ output: 2 }) });
    const result = acc.materialize();
    expect(result.text).toBe("Hello");
    expect(result.usage).toEqual(usage({ output: 2 }));
  });

  it("surfaces usage in snapshot (replace) mode", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observe({ type: "snapshot", data: { count: 5 } } as StreamEvent<Out>);
    acc.observeFinish({ type: "finish", data: {}, usage: usage({ input: 3, output: 1 }) });
    const result = acc.materialize();
    expect(result.count).toBe(5);
    expect(result.usage).toEqual(usage({ input: 3, output: 1 }));
  });

  it("does not add a usage field when no usage was reported", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observe({ type: "text-delta", port: "text", textDelta: "hi" } as StreamEvent<Out>);
    acc.observeFinish({ type: "finish", data: {} });
    const result = acc.materialize();
    expect(result).toEqual({ text: "hi" });
    expect("usage" in result).toBe(false);
  });

  it("reports usage and refusal together — a refused turn is still billed", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observe({
      type: "refusal",
      refusal: "declined",
      category: "output-refusal",
    } as StreamEvent<Out>);
    acc.observeFinish({ type: "finish", data: {}, usage: usage({ input: 12, output: 3 }) });
    expect(acc.materialize()).toEqual({
      refusal: "declined",
      refusalCategory: "output-refusal",
      usage: usage({ input: 12, output: 3 }),
    });
  });

  it("sums usage across several observed finishes (multi-turn)", () => {
    const acc = new StreamEventAccumulator<Out>();
    acc.observe({
      type: "finish",
      data: {},
      usage: usage({ input: 10, output: 2 }),
    } as StreamEvent<Out>);
    acc.observe({
      type: "finish",
      data: {},
      usage: usage({ input: 5, output: 3 }),
    } as StreamEvent<Out>);
    expect(acc.materialize().usage).toEqual(usage({ input: 15, output: 5 }));
  });

  it("includes lastEventType=(none) when materialize is called with no events at all", () => {
    const acc = new StreamEventAccumulator<Out>();
    let caught: unknown;
    try {
      acc.materialize();
    } catch (e) {
      caught = e;
    }
    const err = caught as { code?: string; lastEventType?: string };
    expect(err.code).toBe("ACCUMULATOR_NO_FINISH");
    expect(err.lastEventType).toBe("(none)");
  });
});

describe("usage snapshots", () => {
  const usage = (input: number | undefined, output: number | undefined) => ({
    input,
    output,
    cached: undefined,
    cacheWrite: undefined,
    reasoning: undefined,
    total: undefined,
    extra: undefined,
  });

  it("lets finish supersede the snapshots it summarizes", () => {
    const acc = new StreamEventAccumulator();
    acc.observe({ type: "usage", usage: usage(100, 2) });
    acc.observe({ type: "usage", usage: usage(100, 7) });
    acc.observe({ type: "finish", data: {}, usage: usage(100, 9) });

    expect((acc.materialize() as Record<string, unknown>).usage).toEqual(usage(100, 9));
  });

  it("promotes the last snapshot when finish reports no usage", () => {
    const acc = new StreamEventAccumulator();
    acc.observe({ type: "usage", usage: usage(50, 4) });
    acc.observe({ type: "finish", data: {} });

    expect((acc.materialize() as Record<string, unknown>).usage).toEqual(usage(50, 4));
  });

  it("replaces rather than sums consecutive snapshots when finish reports no usage", () => {
    const acc = new StreamEventAccumulator();
    acc.observe({ type: "usage", usage: usage(100, 2) });
    acc.observe({ type: "usage", usage: usage(100, 7) });
    acc.observe({ type: "finish", data: {} });

    // Snapshots are cumulative, so the second supersedes the first. Neither of
    // the cases above can catch a summing bug: one has a single snapshot, and
    // the other's finish carries its own usage that overwrites the result.
    expect((acc.materialize() as Record<string, unknown>).usage).toEqual(usage(100, 7));
  });

  /**
   * A provider that states no billed totals (HFI text run-fns, OpenAI-shaped
   * chat with no usage trailer) still drives a live ↑↓ counter from
   * character-count guesses. Those are display feedback: settling one makes it
   * this run's recorded spend, which then reaches the output cache, the `usage`
   * event and the `gen_ai.usage.*` span attributes as if the provider had
   * stated it. StreamProcessor refuses the promotion; so does this.
   */
  const estimate = (input: number | undefined, output: number | undefined): Usage => ({
    ...usage(input, output),
    estimated: true,
  });

  it("records no usage at all when finish states none and the snapshot was a guess", () => {
    const acc = new StreamEventAccumulator();
    acc.observe({ type: "usage", usage: estimate(30, 2) });
    acc.observe({ type: "finish", data: {} });

    // Absent, not zeroed: a counter nobody reported must not read as a total.
    expect("usage" in (acc.materialize() as Record<string, unknown>)).toBe(false);
  });

  it("keeps a stated finish total when a guessed snapshot arrives after it", () => {
    const acc = new StreamEventAccumulator();
    acc.observe({ type: "finish", data: {}, usage: usage(28, 5) });
    // Reachable when a provider emits usage after the finish it belongs to.
    acc.observe({ type: "usage", usage: estimate(30, 2) });

    expect((acc.materialize() as Record<string, unknown>).usage).toEqual(usage(28, 5));
  });

  it("keeps only the stated turn across a multi-turn stated/estimated sequence", () => {
    const acc = new StreamEventAccumulator();
    acc.observe({ type: "finish", data: {}, usage: usage(10, 2) });
    acc.observe({ type: "usage", usage: estimate(40, 3) });
    acc.observe({ type: "finish", data: {} });

    // A tool-calling loop bills every turn, so the second finish merges rather
    // than replaces — which is exactly how an unrefused estimate would be added
    // to a real total instead of merely standing in for a missing one.
    expect((acc.materialize() as Record<string, unknown>).usage).toEqual(usage(10, 2));
  });

  it("lets a stated finish supersede a guessed snapshot with no estimated flag left", () => {
    const acc = new StreamEventAccumulator();
    acc.observe({ type: "usage", usage: estimate(30, 2) });
    acc.observe({ type: "finish", data: {}, usage: usage(28, 5) });

    expect((acc.materialize() as Record<string, unknown>).usage).toEqual(usage(28, 5));
  });

  it("still promotes a stated snapshot when finish reports no usage", () => {
    const acc = new StreamEventAccumulator();
    acc.observe({ type: "usage", usage: usage(50, 4) });
    acc.observe({ type: "finish", data: {} });

    // The guard is scoped to guesses: a provider that states a running total
    // and omits it from the finish is still billed for what it stated.
    expect((acc.materialize() as Record<string, unknown>).usage).toEqual(usage(50, 4));
  });
});

describe("mergeUsage", () => {
  it("returns undefined when neither side reported usage", () => {
    expect(mergeUsage(undefined, undefined)).toBeUndefined();
  });

  it("returns the reported side verbatim when the other is absent", () => {
    const a = usage({ input: 5 });
    expect(mergeUsage(a, undefined)).toBe(a);
    expect(mergeUsage(undefined, a)).toBe(a);
  });

  it("preserves undefined field-wise: undefined + undefined stays undefined", () => {
    // The distinction that makes cost math honest — a counter neither provider
    // reported must NOT become 0.
    const merged = mergeUsage(usage({ input: 1 }), usage({ input: 2 }));
    expect(merged?.input).toBe(3);
    expect(merged?.cached).toBeUndefined();
    expect(merged?.cacheWrite).toBeUndefined();
    expect(merged?.reasoning).toBeUndefined();
    expect(merged?.total).toBeUndefined();
  });

  it("preserves a one-sided value: undefined + 5 === 5 (never diluted to 0)", () => {
    const merged = mergeUsage(usage({ input: 1 }), usage({ input: 2, cached: 5 }));
    expect(merged?.cached).toBe(5);
    const flipped = mergeUsage(usage({ cached: 5 }), usage({ input: 2 }));
    expect(flipped?.cached).toBe(5);
  });

  it("adds every normalized counter", () => {
    const merged = mergeUsage(
      usage({
        input: 1,
        output: 2,
        cached: 3,
        cacheWrite: 4,
        imageInput: 7,
        imageCached: 8,
        reasoning: 5,
        total: 6,
      }),
      usage({
        input: 10,
        output: 20,
        cached: 30,
        cacheWrite: 40,
        imageInput: 70,
        imageCached: 80,
        reasoning: 50,
        total: 60,
      })
    );
    expect(merged).toEqual(
      usage({
        input: 11,
        output: 22,
        cached: 33,
        cacheWrite: 44,
        imageInput: 77,
        imageCached: 88,
        reasoning: 55,
        total: 66,
      })
    );
  });

  it("omits unreported image counters rather than writing undefined keys", () => {
    const merged = mergeUsage(usage({ input: 1 }), usage({ input: 2 }))!;
    expect("imageInput" in merged).toBe(false);
    expect("imageCached" in merged).toBe(false);
  });

  it("merges extra: numeric keys are summed, string keys are last-wins", () => {
    const merged = mergeUsage(
      usage({ extra: { audioTokens: 4, tier: "standard", onlyA: 1 } }),
      usage({ extra: { audioTokens: 6, tier: "priority", onlyB: "x" } })
    );
    expect(merged?.extra).toEqual({
      audioTokens: 10,
      tier: "priority",
      onlyA: 1,
      onlyB: "x",
    });
  });

  it("carries extra through when only one side has it", () => {
    expect(mergeUsage(usage({ extra: { a: 1 } }), usage({ input: 2 }))?.extra).toEqual({ a: 1 });
    expect(mergeUsage(usage({ input: 2 }), usage({ extra: { a: 1 } }))?.extra).toEqual({ a: 1 });
  });

  it("takes the later value when a key changes between number and string", () => {
    const merged = mergeUsage(usage({ extra: { k: 3 } }), usage({ extra: { k: "n/a" } }));
    expect(merged?.extra).toEqual({ k: "n/a" });
  });

  it("does not mutate either input", () => {
    const a = usage({ input: 1, extra: { k: 1 } });
    const b = usage({ input: 2, extra: { k: 2 } });
    mergeUsage(a, b);
    expect(a.input).toBe(1);
    expect(a.extra).toEqual({ k: 1 });
    expect(b.extra).toEqual({ k: 2 });
  });
});
