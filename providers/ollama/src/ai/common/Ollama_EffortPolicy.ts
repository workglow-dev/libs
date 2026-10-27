/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelEffort, ModelEffortPolicyFn } from "@workglow/ai/worker";
import {
  EFFORT_POLICY_ALL,
  EFFORT_POLICY_NONE,
  makeProfileEffortPolicy,
  readModelName,
  resolveEnabledEffort,
} from "@workglow/ai/worker";
import { resolveOllamaProfile } from "./Ollama_ModelProfiles";
import type { OllamaModelConfig } from "./Ollama_ModelSchema";

/**
 * Read off the profile's `think`. A level the policy omits resolves to no
 * effort and nothing is sent, so `none` is left out for gpt-oss, which cannot
 * turn thinking off.
 */
export const ollamaEffortPolicy: ModelEffortPolicyFn = makeProfileEffortPolicy(
  resolveOllamaProfile,
  (profile) => {
    if (profile.kind !== "chat") return EFFORT_POLICY_NONE;
    switch (profile.think) {
      case "levels":
        return { supported: ["low", "medium", "high", "extra", "ultra"], default: undefined };
      case "boolean":
        return EFFORT_POLICY_ALL;
      case "none":
        return EFFORT_POLICY_NONE;
    }
  }
);

type OllamaThinkValue = boolean | "low" | "medium" | "high";

function thinkLevel(effort: ModelEffort): "low" | "medium" | "high" | undefined {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
      return effort;
    case "extra":
    case "ultra":
      return "high";
    default:
      return undefined;
  }
}

/**
 * The request's `think` field for the effort a caller set. A model that cannot
 * think rejects `think: true`, so nothing is sent unless the profile says the
 * model thinks and an effort is set.
 */
export function ollamaThinkParam(model: OllamaModelConfig | undefined): {
  think?: OllamaThinkValue;
} {
  const effort = resolveEnabledEffort(model, ollamaEffortPolicy(model));
  if (effort === undefined) return {};
  const { profile } = resolveOllamaProfile(readModelName(model));
  if (profile.kind === "chat" && profile.think === "levels") {
    const level = thinkLevel(effort);
    return level === undefined ? {} : { think: level };
  }
  return { think: effort !== "none" };
}
