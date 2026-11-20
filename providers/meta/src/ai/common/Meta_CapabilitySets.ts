/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability } from "@workglow/ai/worker";

/**
 * Single source of truth for Meta's capability sets.
 *
 * Both `META_RUN_FNS` (the worker-side registration list) and
 * `workerRunFnSpecs()` (the main-thread proxy declaration) derive their
 * `serves` arrays from these named exports. SDK-free so the main thread can
 * import without paying the OpenAI client cost.
 *
 * To add a new capability set: declare a new `as const` constant here, then
 * reference it from both `META_RUN_FNS` and `META_RUN_FN_SPECS`.
 */
export const META_TEXT_GENERATION = ["text.generation"] as const satisfies Capability[];
export const META_TOOL_USE = ["text.generation", "tool-use"] as const satisfies Capability[];
export const META_JSON_MODE = ["text.generation", "json-mode"] as const satisfies Capability[];
export const META_TEXT_REWRITER = ["text.rewriter"] as const satisfies Capability[];
export const META_TEXT_SUMMARY = ["text.summary"] as const satisfies Capability[];
export const META_COUNT_TOKENS = ["model.count-tokens"] as const satisfies Capability[];
export const META_MODEL_SEARCH = ["model.search"] as const satisfies Capability[];
export const META_MODEL_INFO = ["model.info"] as const satisfies Capability[];

/** Aggregated list — for `workerRunFnSpecs()` derivation. Order MUST match `META_RUN_FNS`. */
export const META_CAPABILITY_SETS = [
  META_TEXT_GENERATION,
  META_TOOL_USE,
  META_JSON_MODE,
  META_TEXT_REWRITER,
  META_TEXT_SUMMARY,
  META_COUNT_TOKENS,
  META_MODEL_SEARCH,
  META_MODEL_INFO,
] as const;
