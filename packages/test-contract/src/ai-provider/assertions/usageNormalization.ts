/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Usage } from "@workglow/ai";
import { describe, expect } from "vitest";

import { it } from "../../creditExhaustedSkip";

/**
 * Shared contract for every provider's usage normalization.
 *
 * Each provider reads token counts off a different terminal frame, but they all
 * have to land in {@link Usage} under one rule: **`undefined` means the provider
 * did not report this figure, and never means zero.** Collapsing "not reported"
 * to `0` silently understates spend — a model that billed no cached tokens and
 * a model that says nothing about caching are different facts.
 *
 * A provider registers its mapper here rather than re-litigating the rule in its
 * own suite, so a new provider inherits the same guarantees.
 */

/** The full set of normalized counters, used to check untouched slots. */
const USAGE_COUNTER_FIELDS = [
  "input",
  "output",
  "cached",
  "cacheWrite",
  "reasoning",
  "total",
] as const;

type UsageCounterField = (typeof USAGE_COUNTER_FIELDS)[number];

export interface UsageNormalizationCase {
  /** What this frame represents, e.g. "a cache-hit completion". */
  readonly name: string;
  /** The provider-shaped payload handed to the mapper. */
  readonly frame: unknown;
  /** The exact expected result — compared with `toEqual`, so extra keys fail. */
  readonly expected: Usage | undefined;
}

export interface UsageNormalizationOpts {
  /** Provider name, used in test titles. */
  readonly provider: string;
  /** The provider's own mapper from a raw frame to {@link Usage}. */
  readonly mapUsage: (raw: unknown) => Usage | undefined;
  /** Provider-specific frames and their expected mappings. */
  readonly cases: readonly UsageNormalizationCase[];
  /**
   * A minimal real frame reporting only `sparseReports`. Every counter outside
   * that set must come back `undefined` — this is the zero-vs-absent guard.
   */
  readonly sparseFrame: unknown;
  /** Counters the sparse frame actually reports. */
  readonly sparseReports: readonly UsageCounterField[];
  /**
   * A frame in which the provider genuinely reports `0` for `sparseReports`.
   * Proves the mapper does not discard a real zero along with the absent ones.
   */
  readonly zeroFrame: unknown;
}

/** Assert a mapped {@link Usage} carries only numbers and `undefined`. */
export function assertUsageShape(usage: Usage): void {
  for (const field of USAGE_COUNTER_FIELDS) {
    const value = usage[field];
    if (value === undefined) continue;
    expect(typeof value, `${field} must be a number when reported`).toBe("number");
    expect(Number.isFinite(value as number), `${field} must be finite`).toBe(true);
  }
  if (usage.extra !== undefined) {
    for (const [key, value] of Object.entries(usage.extra)) {
      expect(["number", "string"], `extra.${key} must be a number or string`).toContain(
        typeof value
      );
    }
  }
}

/**
 * Assert the field relationships every provider's mapper must produce.
 *
 * The sum check only runs when the provider states a `total` — it is the
 * provider's own arithmetic, so it is the one place the normalization can be
 * checked against an external authority rather than against itself.
 */
export function assertUsageDisjointness(usage: Usage): void {
  if (usage.reasoning !== undefined && usage.output !== undefined) {
    expect(
      usage.reasoning <= usage.output,
      `reasoning (${usage.reasoning}) is a subset of output (${usage.output})`
    ).toBe(true);
  }
  if (usage.total === undefined) return;
  const parts = [usage.input, usage.cached, usage.cacheWrite, usage.output];
  if (parts.every((part) => part === undefined)) return;
  const sum = parts.reduce<number>((acc, part) => acc + (part ?? 0), 0);
  expect(sum, `input + cached + cacheWrite + output must equal the provider's stated total`).toBe(
    usage.total
  );
}

export function usageNormalizationBlock(opts: UsageNormalizationOpts): void {
  describe(`${opts.provider} usage normalization contract`, () => {
    it("reports nothing when the provider sent no usage payload", () => {
      for (const empty of [undefined, null, {}, "usage", 42]) {
        expect(opts.mapUsage(empty), `mapped ${JSON.stringify(empty) ?? "undefined"}`).toBe(
          undefined
        );
      }
    });

    it("leaves counters the provider did not report as undefined, never 0", () => {
      const usage = opts.mapUsage(opts.sparseFrame);
      expect(usage, "a frame with real counters must map to a Usage").toBeDefined();
      const reported = new Set<UsageCounterField>(opts.sparseReports);
      for (const field of USAGE_COUNTER_FIELDS) {
        if (reported.has(field)) {
          expect(usage![field], `${field} was reported and must survive`).toBeTypeOf("number");
        } else {
          // The whole point: an unreported counter is absent, not zero.
          expect(usage![field], `${field} was not reported and must be undefined`).toBe(undefined);
        }
      }
    });

    it("preserves a genuinely reported zero rather than dropping it", () => {
      const usage = opts.mapUsage(opts.zeroFrame);
      expect(usage, "a frame reporting 0 still reported something").toBeDefined();
      for (const field of opts.sparseReports) {
        expect(usage![field], `${field} reported 0 and must stay 0`).toBe(0);
      }
    });

    it("maps only numbers and undefined into the normalized shape", () => {
      for (const testCase of opts.cases) {
        const usage = opts.mapUsage(testCase.frame);
        if (usage) assertUsageShape(usage);
      }
      const sparse = opts.mapUsage(opts.sparseFrame);
      if (sparse) assertUsageShape(sparse);
    });

    it("keeps input/cached/cacheWrite disjoint and reasoning inside output", () => {
      for (const testCase of opts.cases) {
        const usage = opts.mapUsage(testCase.frame);
        if (usage) assertUsageDisjointness(usage);
      }
      const sparse = opts.mapUsage(opts.sparseFrame);
      if (sparse) assertUsageDisjointness(sparse);
    });

    for (const testCase of opts.cases) {
      it(`maps ${testCase.name}`, () => {
        expect(opts.mapUsage(testCase.frame)).toEqual(testCase.expected);
      });
    }
  });
}
