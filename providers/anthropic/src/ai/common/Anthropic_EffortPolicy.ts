/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EFFORT_POLICY_NONE,
  makeEffortPolicy,
  MODEL_EFFORTS,
  type ModelEffortPolicy,
  type ModelEffortPolicyFn,
} from "@workglow/ai/worker";
import { normalizeAnthropicModelId, parseAnthropicModelId } from "./Anthropic_ModelId";

const CLAUDE = { supported: MODEL_EFFORTS, default: "none" } as const satisfies ModelEffortPolicy;

/** Extended thinking arrived in Claude 3.7; older generations 400 on any thinking field. */
function isPreThinkingClaude(id: string): boolean {
  const parsed = parseAnthropicModelId(normalizeAnthropicModelId(id));
  if (parsed === undefined) return false;
  if (parsed.major !== 3) return parsed.major < 3;
  return (parsed.minor ?? 0) < 7;
}

/**
 * Anthropic serves one family, and every generation from 3.7 up takes the
 * coarse dial on one path or the other, so only the generations that predate
 * thinking are denied. An id this package cannot parse is far likelier to be a
 * spelling it has not seen than a model without thinking, so it keeps the dial:
 * {@link anthropicSupportsAdaptiveThinking} already routes an unparsed id to the
 * legacy `thinking.type = "enabled"` budget, which is the safe landing. Denying
 * whatever the parser declined made that fallback unreachable from
 * `model.effort` — the setting was dropped before anything could use it.
 */
export const anthropicEffortPolicy: ModelEffortPolicyFn = makeEffortPolicy({
  rules: [{ when: isPreThinkingClaude, policy: EFFORT_POLICY_NONE }],
  fallback: CLAUDE,
});
