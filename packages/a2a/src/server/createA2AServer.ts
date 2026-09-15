/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentCard } from "@a2a-js/sdk";
import type { A2ARequestHandler, TaskStore } from "@a2a-js/sdk/server";
import { DefaultRequestHandler } from "@a2a-js/sdk/server";

import type { IA2AAgentDescriptor } from "../util/AgentDescriptor";
import { buildAgentCard } from "../util/agentCard";
import type { RunAgentTurn } from "./AgentTaskExecutor";
import { AgentTaskExecutor } from "./AgentTaskExecutor";
import { BoundedTaskStore } from "./BoundedTaskStore";

export interface CreateA2AServerOptions {
  readonly descriptor: IA2AAgentDescriptor;
  /** Absolute URL the agent answers on; goes into the card. */
  readonly url: string;
  /** Whether the host enforces a bearer token, so the card can say so. */
  readonly authenticated: boolean;
  /**
   * Where tasks live. Defaults to a {@link BoundedTaskStore}, which keeps the
   * most recently touched thousand: `TaskStore` has no delete, and a host that
   * wants persistence across restarts supplies its own.
   */
  readonly taskStore?: TaskStore;
  readonly runTurn?: RunAgentTurn;
}

export interface A2AServer {
  readonly handler: A2ARequestHandler;
  readonly card: AgentCard;
}

/**
 * One descriptor, as the SDK's request handler and the card it publishes.
 *
 * One descriptor and not a list: `A2ARequestHandler.getAgentCard()` returns a
 * single card, so one endpoint publishes one agent. Serving several means
 * several endpoints.
 */
export function createA2AServer(opts: CreateA2AServerOptions): A2AServer {
  const card = buildAgentCard(opts.descriptor, {
    url: opts.url,
    authenticated: opts.authenticated,
  });
  const taskStore = opts.taskStore ?? new BoundedTaskStore();
  const executor = new AgentTaskExecutor({
    descriptor: opts.descriptor,
    runTurn: opts.runTurn,
    taskStore,
  });
  const handler = new DefaultRequestHandler(card, taskStore, executor);
  return { handler, card };
}
