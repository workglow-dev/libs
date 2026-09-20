/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext } from "react";
import type { ListWindow, RunViewportPlan, StatusLike } from "../model/runViewport";
import { EMPTY_RUN_VIEWPORT_PLAN, listCap, listWindow } from "../model/runViewport";

const RunViewportContext = createContext<RunViewportPlan>(EMPTY_RUN_VIEWPORT_PLAN);

/**
 * How many siblings each list may draw, decided once for the whole run.
 *
 * A list cannot work this out for itself: the answer depends on what every
 * other list is drawing, and React hands a component its own subtree and
 * nothing else. The run computes one plan from the census, publishes it here,
 * and each list reads its own line off it — which is also what makes the
 * decision testable without a terminal.
 */
export function RunViewportProvider({
  plan,
  slot,
}: {
  readonly plan: RunViewportPlan;
  readonly slot: React.ReactNode;
}): React.ReactElement {
  return <RunViewportContext.Provider value={plan}>{slot}</RunViewportContext.Provider>;
}

export function useRunViewportPlan(): RunViewportPlan {
  return useContext(RunViewportContext);
}

/**
 * The rows one list draws and the ones it is holding back at either end. A list
 * outside any plan — the census has not caught up with a subgraph that just
 * appeared — falls back to the fixed cap, so a new list is briefly generous
 * rather than briefly empty.
 */
export function useVisibleRows<T extends StatusLike>(
  listKey: string,
  rows: readonly T[]
): ListWindow<T> {
  const plan = useRunViewportPlan();
  return listWindow(rows, listCap(plan, listKey));
}
