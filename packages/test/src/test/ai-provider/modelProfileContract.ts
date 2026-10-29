/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelProfileResolver, ModelProfileSource } from "@workglow/ai/worker";
import { describe, expect, it } from "vitest";

export interface ModelProfileContract<P> {
  readonly provider: string;
  readonly resolve: ModelProfileResolver<P>;
  /** The provider's profile rows, keyed by canonical id. Empty for a provider that has only families. */
  readonly rows: Readonly<Record<string, P>>;
  readonly normalize: (id: string) => string;
  /**
   * The provider's list-pricing table and its resolver. Every priced model
   * needs a row, and every row a price unless `unpriced` names it — so adding
   * a model to either table without the other fails here.
   */
  readonly pricing?:
    | {
        readonly table: Readonly<Record<string, unknown>>;
        readonly unpriced: ReadonlySet<string>;
        readonly price: (modelName: string) => unknown;
      }
    | undefined;
  /** Other spellings of a canonical id that must resolve to the same row. */
  readonly spellings?: ((id: string) => readonly string[]) | undefined;
  /** `[spelling, canonical]` pairs the normalizer must map. */
  readonly normalizes?: readonly (readonly [string, string])[] | undefined;
  /**
   * Ids no row names, with the source and recognition each must resolve to.
   * Every one is also put through {@link agrees}.
   */
  readonly unlisted?:
    | readonly (readonly [modelName: string, source: ModelProfileSource, recognized: boolean])[]
    | undefined;
  /**
   * Asserts that every reader of the profile — request flags, the effort
   * policy, capability inference — answers what the profile says for one model
   * name. `recognized` is passed because capability inference answers only for
   * recognized ids.
   */
  readonly agrees: (modelName: string, profile: P, recognized: boolean) => void;
}

/**
 * The structural half every provider's profile table shares: rows and pricing
 * name one set of models, rows are keyed by their own canonical id and state
 * every field, every spelling of a row resolves to it, and the readers agree
 * with the row. What each reader is asked stays with the provider, in `agrees`.
 */
export function describeModelProfileContract<P extends object>(
  contract: ModelProfileContract<P>
): void {
  const { provider, resolve, rows, normalize, pricing, agrees } = contract;
  const spellings = (id: string): readonly string[] => [id, ...(contract.spellings?.(id) ?? [])];

  describe(`${provider} model profiles`, () => {
    if (pricing !== undefined) {
      it("has a row for every priced model, and only the named extras besides", () => {
        const priced = new Set(Object.keys(pricing.table).map(normalize));
        const profiled = new Set(Object.keys(rows));
        expect([...priced].filter((id) => !profiled.has(id))).toEqual([]);
        expect([...profiled].filter((id) => !priced.has(id)).sort()).toEqual(
          [...pricing.unpriced].sort()
        );
      });
    }

    it("keys every row by its own canonical id, and states every field", () => {
      for (const [id, row] of Object.entries(rows)) {
        expect(normalize(id)).toBe(id);
        for (const [field, value] of Object.entries(row)) {
          expect([id, field, value === undefined]).toEqual([id, field, false]);
        }
      }
    });

    const ids = Object.keys(rows);
    if (ids.length > 0) {
      it.each(ids)("resolves %s from its row in every spelling, and every reader agrees", (id) => {
        const row = rows[id]!;
        for (const spelled of spellings(id)) {
          const resolved = resolve(spelled);
          expect([spelled, resolved.source, resolved.recognized, resolved.id]).toEqual([
            spelled,
            "table",
            true,
            id,
          ]);
          expect(resolved.profile).toBe(row);
          agrees(spelled, row, true);
        }
        if (pricing !== undefined && !pricing.unpriced.has(id)) {
          const canonical = pricing.price(id);
          expect(canonical).toBeDefined();
          for (const spelled of spellings(id)) {
            expect([spelled, pricing.price(spelled)]).toEqual([spelled, canonical]);
          }
        }
      });
    }

    const unlisted = contract.unlisted ?? [];
    if (unlisted.length > 0) {
      it.each(unlisted)("resolves unlisted %s from %s (recognized: %s)", (name, source, known) => {
        const resolved = resolve(name);
        expect([resolved.source, resolved.recognized]).toEqual([source, known]);
        agrees(name, resolved.profile, resolved.recognized);
      });
    }

    const normalizes = contract.normalizes ?? [];
    if (normalizes.length > 0) {
      it.each(normalizes)("normalizes %s to %s", (spelling, canonical) => {
        expect(normalize(spelling)).toBe(canonical);
      });
    }
  });
}
