/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServiceToken } from "@workglow/util";
import type { A2UIServerMessage, A2UIUserAction } from "../protocol/messages";

/** One surface batch, handed to whatever can draw it. */
export type A2UIPresentRequest = {
  /** Correlates a result with the request that asked for it. */
  readonly requestId: string;
  readonly messages: readonly A2UIServerMessage[];
  /** The catalog every surface in the batch named, already checked against the host's. */
  readonly catalogId: string;
  /**
   * Whether the caller is blocking on a user action.
   *
   * A surface with nothing to press is still worth drawing — a receipt, a chart
   * — and a host that always blocks would leave that run hanging on a button
   * the agent never described.
   */
  readonly expectsAction: boolean;
};

export type A2UIPresentStatus = "action" | "dismissed" | "presented";

export type A2UIPresentResult = {
  readonly requestId: string;
  /**
   * - "action": the person used the surface, and `action` says how.
   * - "dismissed": they closed it without acting on it.
   * - "presented": it was drawn and nothing was expected of them.
   */
  readonly status: A2UIPresentStatus;
  readonly action: A2UIUserAction | undefined;
};

/**
 * Whatever can draw an A2UI surface for a person.
 *
 * Its own seam rather than a fifth {@link IHumanConnector} kind, because a
 * surface is not a prompt: a prompt is one question with a fixed set of answers
 * and it is over when one is given, while a surface is a region that lives on,
 * holds its own state, and emits named events the agent chose. Modelling it as
 * a prompt means either flattening every event into accept/decline or widening
 * a contract four connectors and a conformance suite already implement.
 *
 * A host with no way to draw one — a terminal, a headless run — registers
 * nothing, and {@link resolveA2UIConnector} refuses rather than degrading the
 * surface to text. A UI the agent believes was shown, and was not, is worse
 * than a run that stopped and said so.
 */
export interface IA2UIConnector {
  present(request: A2UIPresentRequest, signal: AbortSignal): Promise<A2UIPresentResult>;
}

export const A2UI_CONNECTOR = createServiceToken<IA2UIConnector>("A2UI_CONNECTOR");

/** Resolves the host's connector, or explains what it would have to register. */
export function resolveA2UIConnector(context: {
  readonly registry: {
    has(token: typeof A2UI_CONNECTOR): boolean;
    get(token: typeof A2UI_CONNECTOR): IA2UIConnector;
  };
}): IA2UIConnector {
  if (!context.registry.has(A2UI_CONNECTOR)) {
    throw new Error(
      "A2UI_CONNECTOR not registered. Register one via " +
        "registry.registerInstance(A2UI_CONNECTOR, connector) in a host that can render a surface."
    );
  }
  return context.registry.get(A2UI_CONNECTOR);
}
