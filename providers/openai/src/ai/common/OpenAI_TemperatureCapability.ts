/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OpenAiModelConfig } from "./OpenAI_ModelSchema";

export type OpenAiCapabilitySource = "override" | "table" | "default";

export interface OpenAiTemperatureResolution {
  readonly value: boolean;
  readonly source: OpenAiCapabilitySource;
}

/**
 * Whether a pinned `temperature` is accepted when reasoning is switched to
 * `none`. Reasoning at any other effort rejects a temperature on every model,
 * so this only decides whether the request may turn reasoning off to keep one.
 * First match wins.
 */
const TEMPERATURE_WITH_REASONING_NONE: ReadonlyArray<readonly [RegExp, boolean]> = [
  [/^gpt-5\.6/, true],
  [/^gpt-(?:6|5|4)/, false],
  [/^gpt-image-/, false],
  [/^o\d/, false],
  [/^text-embedding-/, false],
];

/**
 * Whether the configured model keeps a pinned temperature by running with
 * reasoning `none`, and how that was decided.
 * `provider_config.accepts_temperature_with_reasoning` overrides everything.
 *
 * A model no table entry covers answers `false`: a wrong `true` turns reasoning
 * off and sends a temperature the model may 400 on, where a wrong `false` only
 * drops the temperature (with a one-time warning), so an unknown model is not
 * guessed at.
 */
export function resolveOpenAiTemperatureWithReasoning(
  model: OpenAiModelConfig | undefined
): OpenAiTemperatureResolution {
  const override = (
    model?.provider_config as { accepts_temperature_with_reasoning?: unknown } | undefined
  )?.accepts_temperature_with_reasoning;
  if (typeof override === "boolean") return { value: override, source: "override" };
  const id = (model?.provider_config?.model_name ?? "")
    .trim()
    .toLowerCase()
    .replace(/^openai\//, "");
  for (const [pattern, value] of TEMPERATURE_WITH_REASONING_NONE) {
    if (pattern.test(id)) return { value, source: "table" };
  }
  return { value: false, source: "default" };
}
