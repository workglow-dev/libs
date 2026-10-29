/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Usage } from "@workglow/task-graph";
import { TaskConfigurationError } from "@workglow/task-graph";
import type { ModelPricing } from "../model/ModelPricing";
import { promptTokens, reportsPromptTokens, roundCostUsd } from "./AgentTurnRecord";

/** The caps one agent turn runs under; each undefined when the caller set none. */
export interface AgentBudgetLimits {
  readonly maxInputTokens: number | undefined;
  readonly maxCostUsd: number | undefined;
  readonly maxDurationMs: number | undefined;
}

/**
 * What one turn has spent against its caps: prompt tokens, priced spend, and
 * wall-clock time.
 *
 * Three questions are asked of it, and kept apart on purpose:
 *
 * - {@link timeExhausted} — whether a model call may start at a given moment.
 *   Asked before every round and every retry, since a call started past the
 *   deadline is one the budget no longer covers.
 * - {@link mustStopLoop} — asked by the loop once a round's tool results are
 *   recorded: whether another round may start. A round the turn cannot
 *   measure counts here as spending the cap it cannot measure, never as free:
 *   one that reported no prompt count ends a `maxInputTokens` turn, one that
 *   cannot be priced (no usage, or an estimate) ends a `maxCostUsd` turn.
 *   Adding nothing for either would let a capped turn run every round for free.
 * - {@link exhausted} — asked on the answer path, once the model has replied
 *   without a tool: whether what was measured reached a cap. A round that could
 *   not be measured is not evidence the cap was passed, and the model has
 *   finished, so it neither turns the answer into a `"budget"` stop nor
 *   withholds the bounded reminders that ask for a submission.
 */
export class AgentTurnBudget {
  /** When the turn's time runs out; undefined without `maxDurationMs`. */
  public readonly deadline: number | undefined;
  private readonly limits: AgentBudgetLimits;
  private readonly pricing: ModelPricing | undefined;
  private spentTokens = 0;
  private spentUsd = 0;
  private rounds = 0;
  private costKnown = true;
  private uncountedRound = false;
  private unpricedRound = false;

  /**
   * Refuses a `maxCostUsd` with no price card: a budget that cannot be measured
   * would never stop the turn, and the caller set it precisely so that
   * something would.
   */
  constructor(
    limits: AgentBudgetLimits,
    pricing: ModelPricing | undefined,
    startedAt: number = Date.now()
  ) {
    if (limits.maxCostUsd !== undefined && pricing === undefined) {
      throw new TaskConfigurationError(
        "AgentTask: maxCostUsd needs a price card for the model, and none was found"
      );
    }
    this.limits = limits;
    this.pricing = pricing;
    this.deadline =
      limits.maxDurationMs === undefined ? undefined : startedAt + limits.maxDurationMs;
  }

  /** A round's cost in US dollars, priced at the instant it was sent; undefined when it cannot be. */
  public price(usage: Usage | undefined, at: Date): number | undefined {
    return roundCostUsd(usage, this.pricing, at);
  }

  /** Charges one settled round, with the cost {@link price} gave it. */
  public record(usage: Usage | undefined, costUsd: number | undefined): void {
    this.rounds++;
    this.spentTokens += promptTokens(usage);
    if (!reportsPromptTokens(usage)) this.uncountedRound = true;
    if (costUsd === undefined) {
      this.costKnown = false;
      this.unpricedRound = true;
    } else {
      this.spentUsd += costUsd;
    }
  }

  /** Whether the turn's time has run out at `at`; never without `maxDurationMs`. */
  public timeExhausted(at: number = Date.now()): boolean {
    return this.deadline !== undefined && at >= this.deadline;
  }

  /** Whether the spend the turn measured has reached a token or cost cap. */
  public exhausted(): boolean {
    const { maxInputTokens, maxCostUsd } = this.limits;
    return (
      (maxInputTokens !== undefined && this.spentTokens >= maxInputTokens) ||
      (maxCostUsd !== undefined && this.spentUsd >= maxCostUsd)
    );
  }

  /**
   * Whether the loop must end the turn after a round whose tool results are
   * recorded: a cap is {@link exhausted}, or a round could not be measured
   * against it.
   */
  public mustStopLoop(): boolean {
    const { maxInputTokens, maxCostUsd } = this.limits;
    return (
      this.exhausted() ||
      (maxInputTokens !== undefined && this.uncountedRound) ||
      (maxCostUsd !== undefined && this.unpricedRound)
    );
  }

  /** The turn's spend so far; undefined before any round, or once any round could not be priced. */
  public costUsd(): number | undefined {
    return this.costKnown && this.rounds > 0 ? this.spentUsd : undefined;
  }
}
