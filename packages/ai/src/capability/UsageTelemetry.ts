/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TaskOutput, Usage, UsageCounterField } from "@workglow/task-graph";
import { USAGE_COUNTER_FIELDS, USAGE_OUTPUT_KEY } from "@workglow/task-graph";
import type { SpanAttributes } from "@workglow/util";
import { getLogger, getTelemetryProvider } from "@workglow/util";

/**
 * Reads the reserved `usage` field off a materialised task output. Returns
 * `undefined` when the field is absent — no provider on this run reported
 * token counts.
 */
export function readUsage(output: TaskOutput | undefined): Usage | undefined {
  if (!output || typeof output !== "object") return undefined;
  const usage = (output as Record<string, unknown>)[USAGE_OUTPUT_KEY];
  if (!usage || typeof usage !== "object") return undefined;
  return usage as Usage;
}

/**
 * The span attribute each normalized counter is reported under.
 *
 * Keyed by {@link UsageCounterField} rather than written out as a chain of
 * `if`s, so a counter added to {@link Usage} fails to compile here instead of
 * quietly going unreported — which leaves the span's `total_tokens` unable to
 * reconcile against the buckets beside it.
 */
const USAGE_ATTRIBUTE_NAMES: Record<UsageCounterField, string> = {
  input: "gen_ai.usage.input_tokens",
  output: "gen_ai.usage.output_tokens",
  cached: "gen_ai.usage.cached_input_tokens",
  cacheWrite: "gen_ai.usage.cache_write_input_tokens",
  imageInput: "gen_ai.usage.image_input_tokens",
  imageCached: "gen_ai.usage.cached_image_input_tokens",
  reasoning: "gen_ai.usage.reasoning_tokens",
  total: "gen_ai.usage.total_tokens",
};

/**
 * Flattens {@link Usage} into OpenTelemetry gen-ai semantic-convention span
 * attributes. Unreported counters are omitted rather than zeroed, so a
 * consumer can tell "billed nothing" from "told us nothing".
 */
function usageAttributes(usage: Usage, modelId: string | undefined): SpanAttributes {
  const attributes: SpanAttributes = {};
  if (modelId !== undefined) attributes["gen_ai.request.model"] = modelId;
  for (const field of USAGE_COUNTER_FIELDS) {
    const value = usage[field];
    if (value !== undefined) attributes[USAGE_ATTRIBUTE_NAMES[field]] = value;
  }
  if (usage.extra) {
    for (const [key, value] of Object.entries(usage.extra)) {
      attributes[`gen_ai.usage.extra.${key}`] = value;
    }
  }
  return attributes;
}

/**
 * Records one run's token accounting on a telemetry span and a debug log line.
 *
 * Called once from the AI task layer, never from a provider run-fn: providers
 * normalize their own numbers into {@link Usage} and stay free of any telemetry
 * dependency (they also execute inside workers, where the main thread's
 * telemetry provider does not exist).
 *
 * No-ops when the run reported no usage. The span is skipped when no telemetry
 * provider is collecting, so the attribute flattening is never paid for.
 */
export function recordUsageTelemetry(
  output: TaskOutput | undefined,
  taskType: string,
  modelId: string | undefined
): void {
  const usage = readUsage(output);
  if (!usage) return;

  const telemetry = getTelemetryProvider();
  if (telemetry.isEnabled) {
    const span = telemetry.startSpan("workglow.ai.usage", {
      attributes: { "workglow.task.type": taskType, ...usageAttributes(usage, modelId) },
    });
    span.end();
  }

  getLogger().debug(`AI usage for ${taskType}`, { model: modelId, usage });
}
