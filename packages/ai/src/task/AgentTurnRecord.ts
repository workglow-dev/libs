/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { isRetryableError, RetryableJobError } from "@workglow/job-queue";
import type { Usage } from "@workglow/task-graph";
import type { ServiceRegistry } from "@workglow/util";
import { estimateCost } from "../capability/CostEstimate";
import type { ModelPricing } from "../model/ModelPricing";
import { mergeModelPricing } from "../model/ModelPricing";
import { getGlobalModelRepository } from "../model/ModelRegistry";
import type { ModelConfig } from "../model/ModelSchema";
import type { ChatMessage } from "./ChatMessage";
import { getAiProviderRegistry } from "../provider/AiProviderRegistry";

/** The tool an agent given an `outputSchema` finishes its turn with. */
export const AGENT_SUBMIT_TOOL_NAME = "submit_answer";

/** One tool call a round made, as it ran. Its arguments and result are in `messages`. */
export interface AgentToolRecord {
  readonly id: string;
  readonly name: string;
  readonly isError: boolean;
  /** Characters of the result the model was shown. */
  readonly chars: number;
  readonly durationMs: number;
}

/**
 * One round of a turn: the model call and the tools it asked for.
 *
 * Kept beside `messages` rather than inside it, so a host can persist, chart or
 * budget a turn without parsing a transcript, and join back to it by tool-use id.
 */
export interface AgentStep {
  readonly round: number;
  readonly startedAt: string;
  /** The model call alone, retries included. */
  readonly modelMs: number;
  /** The model call and every tool it asked for. */
  readonly durationMs: number;
  /** Model calls this round took: 1, plus each retry after a retryable failure. */
  readonly attempts: number;
  readonly text: string;
  readonly tools: readonly AgentToolRecord[];
  /** As the provider reported it; undefined when it reported none. */
  readonly usage: Usage | undefined;
  /** Undefined when the usage or the model's price card is missing, or the card is not in USD. */
  readonly costUsd: number | undefined;
}

/** What a host's submission check sees besides the answer. */
export interface AgentSubmissionContext {
  /** The turn's transcript so far: every call the model made and what it read. */
  readonly messages: readonly ChatMessage[];
  readonly steps: readonly AgentStep[];
  /** Answers this check has already sent back this turn. */
  readonly rejections: number;
}

/**
 * Judges an answer that passed `outputSchema`: a reason to send it back to the
 * model — something missing, something inconsistent — or undefined to accept.
 * Where the invariants a schema cannot state are enforced in code.
 */
export type AgentSubmissionCheck = (
  answer: unknown,
  turn: AgentSubmissionContext
) => string | undefined | Promise<string | undefined>;

/**
 * Tokens a round sent the model: every slice of the prompt, cached or not.
 * What a context window and an input budget both measure.
 */
export function promptTokens(usage: Usage | undefined): number {
  if (usage === undefined) return 0;
  return (
    (usage.input ?? 0) +
    (usage.cached ?? 0) +
    (usage.cacheWrite ?? 0) +
    (usage.imageInput ?? 0) +
    (usage.imageCached ?? 0)
  );
}

/**
 * The rate card a turn's rounds are priced with: the provider's list card,
 * overridden field by field by any card on the model's own record. Undefined
 * when the model id resolves to nothing or no card exists.
 */
export async function agentModelPricing(
  model: string | ModelConfig,
  registry: ServiceRegistry
): Promise<ModelPricing | undefined> {
  const config =
    typeof model === "string" ? await getGlobalModelRepository(registry).findByName(model) : model;
  if (config === undefined) return undefined;
  const provider = getAiProviderRegistry(registry).getProvider(config.provider);
  return mergeModelPricing(config.pricing, provider?.modelPricing(config));
}

/** A round's cost in US dollars, priced at the instant it was sent. */
export function roundCostUsd(
  usage: Usage | undefined,
  pricing: ModelPricing | undefined,
  at: Date
): number | undefined {
  if (usage === undefined || pricing === undefined) return undefined;
  const estimate = estimateCost(usage, pricing, { at });
  return estimate?.currency === "USD" ? estimate.amount : undefined;
}

/** Whether a failed model call may be made again: a rate limit, an overload, a timeout. */
export function isRetryableRoundError(err: unknown): boolean {
  return isRetryableError(err);
}

const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

/**
 * How long to wait before retry `attempt` (1-based) of a round: the provider's
 * own retry-after when it gave one, else exponential from two seconds; within
 * one second and one minute either way.
 */
export function retryDelayMs(err: unknown, attempt: number, now: number = Date.now()): number {
  const stated = err instanceof RetryableJobError ? err.retryDate?.getTime() : undefined;
  const wanted = stated !== undefined ? stated - now : 2_000 * 2 ** (attempt - 1);
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, wanted));
}

/** Resolves after `ms`, or rejects with the signal's reason the moment it aborts. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
