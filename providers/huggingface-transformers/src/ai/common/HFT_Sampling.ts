/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a run-fn does when the request names no temperature: decode greedily, or
 * send neither key so the model's own `generation_config.json` decides.
 */
export type HftUnsetTemperature = "greedy" | "model-default";

export type HftSamplingOptions =
  | { readonly do_sample: true; readonly temperature: number }
  | { readonly do_sample: false }
  | Record<string, never>;

/**
 * `generate()` options for a caller's `temperature`.
 *
 * transformers.js builds its temperature warper only under `do_sample`, so a
 * temperature forwarded on its own is honoured or silently dropped depending on
 * what the model's generation config says about sampling. The two are always set
 * together: a positive temperature samples at that temperature, and `0` decodes
 * greedily (transformers.js itself turns `do_sample` off at `0`).
 */
export function hftSamplingOptions(
  temperature: number | undefined,
  whenUnset: HftUnsetTemperature
): HftSamplingOptions {
  if (temperature === undefined) {
    return whenUnset === "greedy" ? { do_sample: false } : {};
  }
  return temperature > 0 ? { do_sample: true, temperature } : { do_sample: false };
}
