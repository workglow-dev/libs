/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITask, TaskGraph } from "@workglow/task-graph";
import { useCallback, useEffect, useRef, useState } from "react";
import { taskErrorText } from "./components/TaskErrorDetail";
import type { CensusList, CensusNode, RunTaskCounts } from "./model/runCensus";
import {
  EMPTY_CENSUS_LIST,
  EMPTY_RUN_CENSUS_LEDGER,
  EMPTY_RUN_TASK_COUNTS,
  mergeRunCensus,
  runTaskCounts,
} from "./model/runCensus";
import { sortCliTaskLinesForDisplay } from "./model/runRowModel";
import { isIteratorTask } from "./model/iteratorTask";

const TICK_MS = 250;

/**
 * How deep to follow ownership, matching what the rows draw. A task that owns a
 * workflow produces a wrapper row whose children are the real work, so one
 * level is never enough; past this the rows stop and so does the walk, because
 * a census that counted rows nobody draws would price the viewport for a tree
 * that is not on screen.
 */
const MAX_OWNED_DEPTH = 3;

/** Nodes one walk may produce before it gives up and reports what it has. */
const MAX_WALK_NODES = 5000;

function subGraphOf(task: ITask): TaskGraph | undefined {
  return (task as { subGraph?: TaskGraph }).subGraph;
}

function hasChildren(task: ITask): boolean {
  const probe = (task as { hasChildren?: () => boolean }).hasChildren;
  return typeof probe === "function" ? probe.call(task) : subGraphOf(task) !== undefined;
}

function liveIterationGraphs(task: ITask): Array<{ index: number; graph: TaskGraph }> {
  const probe = (
    task as { getVisibleIterationGraphs?: () => Array<{ index: number; graph: TaskGraph }> }
  ).getVisibleIterationGraphs;
  return typeof probe === "function" ? (probe.call(task) ?? []) : [];
}

/** The list key holding a Map/Reduce task's in-flight iterations. */
export function iterationGroupKey(nodeKey: string): string {
  return `${nodeKey}#`;
}

/** The list key holding the tasks of one in-flight iteration. */
export function iterationListKey(nodeKey: string, index: number): string {
  return `${nodeKey}#${index}`;
}

/**
 * A node that has not started while work beneath it already has.
 *
 * `context.own(new Workflow())` puts a wrapper task in the subgraph so the
 * workflow's tasks have a place in the tree, and then the caller runs the
 * workflow rather than the wrapper — so the wrapper stays PENDING for the
 * whole run and would sit in the total forever as one task that never lands.
 * It is scaffolding around the work, not work, and the run is finished when
 * its children are.
 */
function isOwnershipWrapper(status: string, lists: readonly CensusList[]): boolean {
  if (status !== "PENDING") return false;
  for (const list of lists) {
    for (const node of list.nodes) {
      if (node.status !== "PENDING") return true;
    }
  }
  return false;
}

function taskTypeOf(task: ITask): string {
  return (task as { type?: string }).type ?? "Unknown";
}

function usageIsWorthARow(task: ITask): boolean {
  const usage = task.runUsage;
  if (!usage) return false;
  return (usage.input ?? 0) > 0 || (usage.output ?? 0) > 0 || (usage.cached ?? 0) > 0;
}

/**
 * Rows a task draws for itself: its status line, the usage line beneath it when
 * it has spend, and the bounded error detail when it failed. The estimate only
 * has to be close — the region clips whatever the plan underestimates — but a
 * plan that assumed one row per task would price a failed AI step at a third of
 * what it draws.
 */
function ownRowsOf(task: ITask, status: string): number {
  let rows = 1;
  if (usageIsWorthARow(task)) rows += 1;
  const error = taskErrorText(task, status);
  if (error) rows += error.split("\n").length;
  return rows;
}

interface WalkBudget {
  remaining: number;
}

/**
 * One list of siblings, in the order and with the recursion the rows use.
 *
 * `ownedDepth` counts owned subgraphs and resets inside a Map iteration,
 * because an iteration clone is a fresh tree the rows also restart their own
 * depth for. `seen` guards a subgraph that reaches back into an ancestor — the
 * DAG forbids it, but a walk on a live structure should not be the thing that
 * discovers otherwise.
 */
function walkGraph(
  graph: TaskGraph,
  key: string,
  ownedDepth: number,
  seen: Set<TaskGraph>,
  budget: WalkBudget
): CensusList {
  if (seen.has(graph) || budget.remaining <= 0) return { key, nodes: [] };
  seen.add(graph);

  const tasks = graph.getTasks();
  const order = new Map(tasks.map((t, i) => [String(t.id), i]));
  const sorted = sortCliTaskLinesForDisplay(
    tasks.map((t) => ({ id: String(t.id), status: String(t.status), task: t })),
    order
  );

  const nodes: CensusNode[] = [];
  for (const row of sorted) {
    if (budget.remaining <= 0) break;
    budget.remaining--;
    const nodeKey = `${key}/${row.id}`;
    const lists = childListsOf(row.task, nodeKey, ownedDepth, seen, budget);
    nodes.push({
      key: nodeKey,
      id: row.id,
      status: row.status,
      ownRows: ownRowsOf(row.task, row.status),
      countable: !isOwnershipWrapper(row.status, lists),
      lists,
    });
  }

  seen.delete(graph);
  return { key, nodes };
}

function childListsOf(
  task: ITask,
  nodeKey: string,
  ownedDepth: number,
  seen: Set<TaskGraph>,
  budget: WalkBudget
): readonly CensusList[] {
  if (isIteratorTask(task)) {
    // One group holding a node per in-flight iteration, so the plan can decide
    // how many iterations to show as well as how much of each — a Map at high
    // concurrency otherwise floors the run at one subtree per running item, and
    // the plan has nothing left to give back.
    const nodes: CensusNode[] = [];
    for (const { index, graph } of liveIterationGraphs(task)) {
      const list = walkGraph(graph, iterationListKey(nodeKey, index), 0, seen, budget);
      if (list.nodes.length === 0) continue;
      nodes.push({
        key: iterationListKey(nodeKey, index),
        id: String(index),
        status: String(task.status),
        ownRows: 0,
        countable: false,
        lists: [list],
      });
    }
    return nodes.length > 0 ? [{ key: iterationGroupKey(nodeKey), nodes }] : [];
  }

  if (ownedDepth >= MAX_OWNED_DEPTH) return [];
  const sub = subGraphOf(task);
  if (!hasChildren(task) || !sub) return [];
  const list = walkGraph(sub, nodeKey, ownedDepth + 1, seen, budget);
  if (list.nodes.length === 0) return [];
  // A lone child of the parent's own type is the same work seen twice — a
  // job-queue mirror — and the rows do not draw it either.
  if (list.nodes.length === 1) {
    const only = list.nodes[0];
    const child = sub.getTasks().find((t) => String(t.id) === only.id);
    if (child && taskTypeOf(child) === taskTypeOf(task)) return [];
  }
  return [list];
}

/** Walks a graph's whole tree the way the rows draw it. */
export function censusOfGraph(graph: TaskGraph): CensusList {
  return walkGraph(graph, "", 0, new Set(), { remaining: MAX_WALK_NODES });
}

/**
 * Walks a single task and everything it owns, for the single-task view, where
 * the task itself is a row rather than a member of a root list.
 */
export function censusOfTask(task: ITask): CensusList {
  const budget: WalkBudget = { remaining: MAX_WALK_NODES };
  const seen = new Set<TaskGraph>();
  const key = `/${String(task.id)}`;
  const status = String(task.status);
  return {
    key: "",
    nodes: [
      {
        key,
        id: String(task.id),
        status,
        ownRows: ownRowsOf(task, status),
        countable: true,
        lists: childListsOf(task, key, 0, seen, budget),
      },
    ],
  };
}

export interface RunCensusState {
  /** The tree as it stands, for pricing the viewport. */
  readonly tree: CensusList;
  /** Everything the run has ever contained, for the footer. */
  readonly counts: RunTaskCounts;
}

const EMPTY_RUN_CENSUS_STATE: RunCensusState = {
  tree: EMPTY_CENSUS_LIST,
  counts: EMPTY_RUN_TASK_COUNTS,
};

/**
 * A cheap structural fingerprint of a walk. The census re-walks on a timer and
 * most walks find exactly what the last one did; handing React a fresh tree
 * object each time would re-reconcile the run's whole row tree four times a
 * second for nothing.
 */
function censusSignature(list: CensusList): string {
  const parts: string[] = [];
  const walk = (l: CensusList): void => {
    parts.push(l.key, String(l.nodes.length));
    for (const node of l.nodes) {
      parts.push(node.key, node.status, String(node.ownRows));
      for (const child of node.lists) walk(child);
    }
  };
  walk(list);
  return parts.join("\u0000");
}

/**
 * Polled rather than event-driven, unlike the rows. The rows subscribe because
 * a subtask that starts and finishes inside one interval must still get a row;
 * the census only has to be right about totals, and the ledger it feeds credits
 * a node that vanished between two ticks as work that completed. One walk on a
 * timer beats wiring a listener onto every node of a tree that grows by the
 * hundred.
 */
function useCensus(sample: (() => CensusList) | undefined): RunCensusState {
  const [state, setState] = useState<RunCensusState>(EMPTY_RUN_CENSUS_STATE);
  const ledgerRef = useRef(EMPTY_RUN_CENSUS_LEDGER);
  const signatureRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!sample) return;
    // A new subject is a new run: the previous one's paths are neither in this
    // tree nor work this run did, and carrying them would seed the footer with
    // a total the run can never meet.
    ledgerRef.current = EMPTY_RUN_CENSUS_LEDGER;
    signatureRef.current = undefined;
    const tick = (): void => {
      const tree = sample();
      const signature = censusSignature(tree);
      const merged = mergeRunCensus(ledgerRef.current, tree);
      const ledgerChanged = merged !== ledgerRef.current;
      ledgerRef.current = merged;
      if (signature === signatureRef.current && !ledgerChanged) return;
      signatureRef.current = signature;
      const counts = runTaskCounts(merged);
      setState({ tree, counts });
    };
    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [sample]);

  return state;
}

/** Tracks what a whole run contains — see {@link useCensus}. */
export function useGraphRunCensus(graph: TaskGraph): RunCensusState {
  const sample = useCallback(() => censusOfGraph(graph), [graph]);
  return useCensus(sample);
}

/** The single-task view's census: the task itself plus everything it owns. */
export function useTaskRunCensus(task: ITask): RunCensusState {
  const sample = useCallback(() => censusOfTask(task), [task]);
  return useCensus(sample);
}
