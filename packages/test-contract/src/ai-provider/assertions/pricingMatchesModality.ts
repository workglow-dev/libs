/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelPricing } from "@workglow/ai";
import { expect } from "vitest";

/** One fixture model, its inferred capabilities, and the card its provider returns. */
export interface PricedModel {
  readonly id: string;
  readonly capabilities: readonly string[];
  readonly pricing: ModelPricing | undefined;
}

/**
 * Capabilities billed by something other than a token.
 *
 * An image is billed per image, speech per character or per second. A card
 * carrying `input`/`output` per-1M-token rates for one of these is not an
 * approximation of the real price — it is a different unit, and arithmetic on
 * it produces a number with no meaning that renders beside real costs.
 */
const NOT_TOKEN_BILLED: ReadonlySet<string> = new Set([
  "image.generation",
  "audio.speech",
  "audio.transcription",
]);

/** Whether a card quotes a per-token rate at all. */
function quotesTokenRate(pricing: ModelPricing | undefined): boolean {
  if (pricing === undefined) return false;
  return (
    typeof pricing.input === "number" ||
    typeof pricing.output === "number" ||
    typeof pricing.cached === "number"
  );
}

/**
 * A provider must not quote a per-token rate for a model its own inference says
 * is not billed per token.
 *
 * This is the direction that catches a real fabricated number, and it is a hard
 * assertion because there is no legitimate case for it: `grok-2-image-1212`
 * resolved `grok-2`'s per-1M-token card through the pricing table's substring
 * walk, and `gemini-2.5-flash-image-preview` took `gemini-2.5-flash`'s the same
 * way. Both are image models by the provider's own catalogue.
 *
 * A free card is exempt: `input: 0` on a local model says "this costs nothing",
 * which is true whatever the billing unit, and is how every local provider
 * answers.
 */
export function assertPricingMatchesModality(
  name: string,
  models: readonly PricedModel[],
  namedByTable: readonly string[] = []
): void {
  const named = new Set(namedByTable);
  const fabricated: string[] = [];
  for (const { id, capabilities, pricing } of models) {
    if (!capabilities.some((capability) => NOT_TOKEN_BILLED.has(capability))) continue;
    if (!quotesTokenRate(pricing)) continue;
    // A card the provider's table names outright is a deliberate rate, not a
    // borrowed one. Recorded per provider rather than inferred, so adding an
    // image model to a table is a decision someone writes down.
    if (named.has(id)) continue;
    const free = (pricing?.input ?? 0) === 0 && (pricing?.output ?? 0) === 0;
    if (free) continue;
    const billed = capabilities.filter((capability) => NOT_TOKEN_BILLED.has(capability));
    fabricated.push(
      `${id}: ${billed.join(", ")} but priced ` +
        `input=${String(pricing?.input)} output=${String(pricing?.output)} per 1M tokens`
    );
  }

  expect(fabricated, `${name} borrows a per-token rate for a model not billed per token`).toEqual(
    []
  );

  // The recorded set must stay honest too: an id that stopped being priced, or
  // stopped being an image model, should leave it rather than sit there
  // exempting nothing.
  const stale = namedByTable.filter(
    (id) =>
      !models.some(
        ({ id: modelId, capabilities, pricing }) =>
          modelId === id &&
          capabilities.some((capability) => NOT_TOKEN_BILLED.has(capability)) &&
          quotesTokenRate(pricing)
      )
  );
  expect(
    stale,
    `${name}: recorded as deliberately priced but no longer is: ${stale.join(", ")}`
  ).toEqual([]);
}

/**
 * The weaker direction: a token-billed model SHOULD carry a card.
 *
 * A ratchet rather than an assertion, deliberately. Real gaps exist today —
 * `gemini-embedding-001` among them — and a hard assert would redden the build
 * on a known one and get disabled, which costs more than the gap. Recording the
 * set means it cannot grow while it shrinks deliberately.
 */
export function assertPricedGapDoesNotGrow(
  name: string,
  models: readonly PricedModel[],
  knownUnpriced: readonly string[]
): void {
  const unpriced = models
    .filter(
      ({ capabilities, pricing }) =>
        capabilities.length > 0 &&
        !capabilities.some((capability) => NOT_TOKEN_BILLED.has(capability)) &&
        pricing === undefined
    )
    .map(({ id }) => id)
    .sort();

  const known = new Set(knownUnpriced);
  expect(
    unpriced.filter((id) => !known.has(id)),
    `${name} has a token-billed model with no rate card that was not recorded`
  ).toEqual([]);

  // Not a failure — a prompt to shrink the recorded set once a gap is closed.
  const closed = knownUnpriced.filter((id) => !unpriced.includes(id));
  expect(closed, `${name}: now priced — drop from the recorded set: ${closed.join(", ")}`).toEqual(
    []
  );
}
