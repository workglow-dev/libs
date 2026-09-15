/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentTaskInput } from "@workglow/ai";
import type { DataPortSchemaObject } from "@workglow/util/schema";

/** One thing an agent is published as able to do. */
export interface IA2ASkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly examples: readonly string[];
  /** What a caller's parts bind onto. Undefined means one text part, one port. */
  readonly inputSchema: DataPortSchemaObject | undefined;
}

/**
 * One servable agent, as this package needs it — and nothing more.
 *
 * Deliberately host-neutral: no `AgentEntity`, no `project_id`, no
 * `TaskGraphJson`. A host projects its own record onto this, which is what
 * lets the CLI serve a saved graph and builder serve a database row through
 * one adapter. Today the CLI is the only host, so this is a bet on the second
 * one rather than a shape two callers have already demanded.
 */
export interface IA2AAgentDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly skills: readonly IA2ASkill[];
  /** Model, system prompt, tools and round caps — everything but the prompt. */
  readonly agentInput: Omit<AgentTaskInput, "prompt">;
}
