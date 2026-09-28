/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServiceToken } from "@workglow/util";
import type { ToolCallingTaskInput, ToolCallingTaskOutput } from "./ToolCallingTask";

/** What {@link AgentTask} hands a host round runner besides the round's input. */
export interface AgentRoundContext {
  /** The turn's signal. A round still in flight after it fires is paid for and thrown away. */
  readonly signal: AbortSignal;
  /** The round's text as it streams, re-emitted as the turn's own. */
  readonly onTextDelta: (delta: string) => void;
  /**
   * Progress while the round has nothing to say yet — a model being downloaded
   * or loaded. `progress` is 0..100, or undefined when there is no denominator.
   */
  readonly onProgress: (progress: number | undefined, message: string | undefined) => void;
}

/**
 * Runs one of {@link AgentTask}'s rounds — one model call — somewhere other than
 * in this process, and returns what a `ToolCallingTask` would have.
 *
 * The loop and the model call want different places. The tools are often host
 * closures that draw on a screen, ask a person, or read state only this process
 * holds, so the loop has to run where they live; the model call needs the
 * credentials and local models, which a desktop or cloud shell keeps in a
 * backend. A serialized graph cannot carry the closures across, so without this
 * a host has to choose between tools that work and a model that is reachable.
 * Bound, the loop and every tool stay here and only the round crosses.
 *
 * It is a registry binding rather than an input for the same reason
 * `AGENT_APPROVAL_OPT_OUT` is: the input can arrive as graph JSON the host did
 * not author, and where a turn's model calls go is the host's to decide.
 *
 * `input` is what the owned `ToolCallingTask` would have been given: the
 * history already trimmed and normalized, the tools as the turn received them —
 * `execute` included, which a serializing runner drops without losing anything
 * the model reads. `model` is whatever the turn resolved, which in this process
 * may be a full `ModelConfig`; a runner sending the round elsewhere may prefer
 * to name the model the way the far side resolves it.
 */
export type AgentRoundRunner = (
  input: ToolCallingTaskInput,
  context: AgentRoundContext
) => Promise<ToolCallingTaskOutput>;

export const AGENT_ROUND_RUNNER = createServiceToken<AgentRoundRunner>("ai.agent.roundRunner");
