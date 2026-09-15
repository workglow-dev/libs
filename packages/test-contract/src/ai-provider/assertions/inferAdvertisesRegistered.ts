/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from "vitest";

/**
 * A registered run-fn capability that `inferCapabilities` never returns is
 * unreachable for any model whose record was populated by inference — the
 * path the catalog exists to serve.
 *
 * The inferred sets are unioned across the provider's fixtures, so this
 * answers "is this capability reachable at all" and says nothing about any one
 * model; {@link assertInferServesInferred} is the per-model direction.
 */
export function assertInferAdvertisesRegistered(
  name: string,
  registered: readonly (readonly string[])[],
  inferred: readonly (readonly string[])[]
): void {
  const registeredCaps = new Set(registered.flat());
  const inferredCaps = new Set(inferred.flat());
  const missing = [...registeredCaps].filter((cap) => !inferredCaps.has(cap)).sort();
  expect(
    missing,
    `${name} registers capabilities that inferCapabilities never returns: ${missing.join(", ")}`
  ).toEqual([]);
}
