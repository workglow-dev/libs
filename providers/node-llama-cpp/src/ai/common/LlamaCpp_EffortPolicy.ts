/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelEffort, ModelEffortPolicyFn } from "@workglow/ai/worker";
import { EFFORT_POLICY_ALL, makeEffortPolicy, resolveEnabledEffort } from "@workglow/ai/worker";

/**
 * A local GGUF's ability to think is not knowable from its path, so every
 * level is offered. A thought budget on a model that does not think is ignored
 * by the chat wrapper, which makes offering the dial harmless where it does
 * not apply.
 */
export const llamaCppEffortPolicy: ModelEffortPolicyFn = makeEffortPolicy({
  rules: [],
  fallback: EFFORT_POLICY_ALL,
});

const THOUGHT_TOKENS: Readonly<Record<ModelEffort, number>> = {
  none: 0,
  low: 512,
  medium: 1024,
  high: 2048,
  extra: 4096,
  ultra: 8192,
};

/**
 * The `budgets.thoughtTokens` a caller's effort asks for, or `undefined` when
 * no effort is set so the SDK keeps its own default (a share of the context).
 */
export function llamaCppThoughtBudget(model: object | undefined): number | undefined {
  const effort = resolveEnabledEffort(model, llamaCppEffortPolicy(model));
  return effort === undefined ? undefined : THOUGHT_TOKENS[effort];
}
