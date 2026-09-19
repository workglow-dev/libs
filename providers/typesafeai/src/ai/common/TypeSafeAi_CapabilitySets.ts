/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability } from "@workglow/ai/worker";

/**
 * Single source of truth for TypeSafe's capability sets.
 *
 * Both `TYPESAFEAI_RUN_FNS` (the worker-side registration list) and
 * `TYPESAFEAI_RUN_FN_SPECS` (the main-thread proxy declaration) derive their
 * `serves` arrays from these named exports. SDK-free so the main thread can
 * import without paying the SDK's cost.
 *
 * The list is short because Jev answers questions rather than writing text:
 * there is no generation, no embedding and no tokenizer endpoint to serve, and
 * a set declared here that the model cannot honor would be selected and then
 * fail inside the provider.
 *
 * To add a new capability set: declare a new `as const` constant here, then
 * reference it from both `TYPESAFEAI_RUN_FNS` and `TYPESAFEAI_RUN_FN_SPECS`.
 */
export const TYPESAFEAI_SYSTEM_ONE = ["judgment.systemone"] as const satisfies Capability[];
export const TYPESAFEAI_TEXT_CLASSIFICATION = [
  "text.classification",
] as const satisfies Capability[];
export const TYPESAFEAI_TEXT_RERANKING = ["text.reranking"] as const satisfies Capability[];
export const TYPESAFEAI_MODEL_SEARCH = ["model.search"] as const satisfies Capability[];
export const TYPESAFEAI_MODEL_INFO = ["model.info"] as const satisfies Capability[];

/** Aggregated list — for `TYPESAFEAI_RUN_FN_SPECS` derivation. Order MUST match `TYPESAFEAI_RUN_FNS`. */
export const TYPESAFEAI_CAPABILITY_SETS = [
  TYPESAFEAI_SYSTEM_ONE,
  TYPESAFEAI_TEXT_CLASSIFICATION,
  TYPESAFEAI_TEXT_RERANKING,
  TYPESAFEAI_MODEL_SEARCH,
  TYPESAFEAI_MODEL_INFO,
] as const;
