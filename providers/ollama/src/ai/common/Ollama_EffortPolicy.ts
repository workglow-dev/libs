/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelEffort, ModelEffortPolicyFn } from "@workglow/ai/worker";
import {
  EFFORT_POLICY_ALL,
  EFFORT_POLICY_NONE,
  makeEffortPolicy,
  resolveEnabledEffort,
} from "@workglow/ai/worker";
import type { OllamaModelConfig } from "./Ollama_ModelSchema";

const GPT_OSS = /^gpt-oss/i;

/** Families Ollama marks as thinking-capable; they take `think: true | false`. */
const THINKING = [
  /^qwen3/i,
  /^deepseek-r1/i,
  /^deepseek-v3\.[1-9]/i,
  /^magistral/i,
  /^qwq/i,
  /^phi4-reasoning/i,
  /^cogito/i,
  /^granite3\.[2-9]/i,
];

/**
 * gpt-oss takes a level and cannot turn thinking off, so `none` is not listed:
 * a level the policy omits resolves to no effort and nothing is sent.
 */
export const ollamaEffortPolicy: ModelEffortPolicyFn = makeEffortPolicy({
  rules: [
    {
      when: GPT_OSS,
      policy: { supported: ["low", "medium", "high", "extra", "ultra"], default: undefined },
    },
    { when: THINKING, policy: EFFORT_POLICY_ALL },
  ],
  fallback: EFFORT_POLICY_NONE,
});

type OllamaThink = boolean | "low" | "medium" | "high";

function gptOssLevel(effort: ModelEffort): "low" | "medium" | "high" | undefined {
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
 * think rejects `think: true`, so nothing is sent unless the policy says the
 * model thinks and an effort is set.
 */
export function ollamaThinkParam(model: OllamaModelConfig | undefined): {
  think?: OllamaThink;
} {
  const effort = resolveEnabledEffort(model, ollamaEffortPolicy(model));
  if (effort === undefined) return {};
  const name = model?.provider_config?.model_name ?? "";
  if (GPT_OSS.test(name)) {
    const level = gptOssLevel(effort);
    return level === undefined ? {} : { think: level };
  }
  return { think: effort !== "none" };
}
