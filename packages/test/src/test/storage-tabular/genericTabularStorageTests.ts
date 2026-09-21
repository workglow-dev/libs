/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Re-export shim. The suite itself moved to `@workglow/test-contract`, because
 * an adapter written outside this repository was inheriting transactions,
 * criteria and join from that package and nothing at all about put, get,
 * delete or query — the half with no compiler behind it and the half an
 * adapter is most likely to get subtly wrong.
 *
 * The concrete `*.test.ts` files that call it stay here, which is the boundary
 * the package exists to draw: everything there is reusable and nothing there
 * runs on its own.
 */
export * from "@workglow/test-contract/tabular-storage";
