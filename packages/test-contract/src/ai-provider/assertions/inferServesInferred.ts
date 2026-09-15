/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from "vitest";

/** One fixture model id paired with the capabilities `inferCapabilities` returns for it. */
export interface InferredForModel {
  readonly id: string;
  readonly capabilities: readonly string[];
}

/**
 * `vision-input` says how a model accepts input rather than a call the provider
 * can be asked to run. The other modifiers ride along inside a generation
 * run-fn's `serves` (`["text.generation", "tool-use"]`), but nothing registers
 * `vision-input`, so it annotates the record and is never a lookup key.
 */
const MARKER_CAPABILITIES: ReadonlySet<string> = new Set(["vision-input"]);

/**
 * Capabilities whose run-fn acts on a chat session, and only the generative
 * run-fns ever open one. `serves` is registered per provider rather than per
 * model, so the subset check alone cannot see that a model without
 * `text.generation` has no session to warm or free.
 */
const SESSION_CAPABILITIES: ReadonlySet<string> = new Set(["cache.checkpoint", "session.dispose"]);

/**
 * The per-model direction of {@link assertInferAdvertisesRegistered}: that one
 * unions the inferred sets across a provider's fixtures, which answers "is this
 * capability reachable at all" and passes a branch that advertises a capability
 * no run-fn can serve *for that model*. Such a model clears
 * `modelMeetsRequires` during selection and fails inside the provider instead,
 * with the capability message it would have gotten replaced by whatever the
 * provider throws.
 */
export function assertInferServesInferred(
  name: string,
  registered: readonly (readonly string[])[],
  inferred: readonly InferredForModel[]
): void {
  const unservable: string[] = [];
  for (const { id, capabilities } of inferred) {
    const inferredSet = new Set(capabilities);
    for (const capability of capabilities) {
      if (MARKER_CAPABILITIES.has(capability)) continue;
      const servable = registered.some(
        (serves) => serves.includes(capability) && serves.every((cap) => inferredSet.has(cap))
      );
      if (!servable) {
        unservable.push(`${id}: ${capability} — no run-fn serves it within this model's set`);
      } else if (SESSION_CAPABILITIES.has(capability) && !inferredSet.has("text.generation")) {
        unservable.push(`${id}: ${capability} — no session without text.generation`);
      }
    }
  }
  expect(
    unservable,
    `${name} infers capabilities it cannot serve for that model:\n  ${unservable.join("\n  ")}`
  ).toEqual([]);
}
