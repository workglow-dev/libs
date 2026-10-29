/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelEffort, ModelEffortPolicyFn } from "@workglow/ai/worker";
import {
  EFFORT_POLICY_ALL,
  makeProfileEffortPolicy,
  resolveEnabledEffort,
} from "@workglow/ai/worker";
import { resolveLlamaCppProfile } from "./LlamaCpp_ModelProfiles";

/**
 * Every level on every profile. A local GGUF's ability to think is not
 * knowable from its name, and a thought budget on a model that does not think
 * is ignored by the chat wrapper, which makes offering the dial harmless where
 * it does not apply.
 */
export const llamaCppEffortPolicy: ModelEffortPolicyFn = makeProfileEffortPolicy(
  resolveLlamaCppProfile,
  () => EFFORT_POLICY_ALL
);

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

/** `session.prompt`'s thought budget for the effort a caller set; nothing when unset. */
export function llamaCppThoughtBudgetOption(model: object | undefined): {
  budgets?: { thoughtTokens: number };
} {
  const thoughtTokens = llamaCppThoughtBudget(model);
  return thoughtTokens === undefined ? {} : { budgets: { thoughtTokens } };
}
