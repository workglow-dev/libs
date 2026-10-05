/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveOpenAiProfile } from "./OpenAI_ModelProfiles";
import type { OpenAiModelConfig } from "./OpenAI_ModelSchema";

export type OpenAiCapabilitySource = "override" | "table" | "default";

export interface OpenAiTemperatureResolution {
  readonly value: boolean;
  readonly source: OpenAiCapabilitySource;
}

/**
 * Whether the configured model keeps a pinned temperature by running with
 * reasoning `none`, and how that was decided.
 * `provider_config.accepts_temperature_with_reasoning` overrides everything;
 * otherwise the model's row in `OPENAI_MODEL_PROFILES` answers.
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
  const { profile, source } = resolveOpenAiProfile(model?.provider_config?.model_name);
  return { value: profile?.acceptsTemperatureWithReasoning ?? false, source };
}
