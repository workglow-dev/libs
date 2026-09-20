/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CensusList, CensusNode } from "./runCensus";

/**
 * How a run's rows are fitted into the terminal, independent of what draws
 * them.
 *
 * Three rules shape everything here.
 *
 * **The live region never shrinks.** A block whose height tracks its content
 * drags the footer up the screen every time a list gets shorter, and a footer
 * that moves is a footer nobody can read. The region grows to fit what arrives
 * and then holds that height ({@link stickyRegionHeight}) until the terminal
 * itself changes size.
 *
 * **A list shows the work in flight.** Rows sort completed → running →
 * pending, so a list of a graph that runs in order is a timeline, and the only
 * part of it worth a row is where the frontier is. {@link listWindow} puts the
 * window there and lets it walk forward as tasks land, rather than pinning
 * either end — the head is work that finished minutes ago and the tail is work
 * that has not started.
 *
 * **Depth pays for the overflow.** When the tree wants more rows than the
 * terminal has, the rows that go are the innermost ones — a Map's per-item
 * detail — because the ancestors are the context that makes the detail legible.
 * Losing the Map's own row to show six more of its items is exactly backwards,
 * so {@link planRunViewport} shrinks the deepest list first and only climbs
 * when that list is down to a single row.
 */

/** Rows one list shows before it starts hiding siblings. */
export const MAX_VISIBLE_LIST_ROWS = 6;

/** A truncated list always keeps at least this many rows — an empty parent says nothing. */
export const MIN_VISIBLE_LIST_ROWS = 1;

/**
 * Settled rows the window keeps above the frontier when it can spare them.
 *
 * One is enough: the row above a running task is the one that just finished,
 * which is the context that says the pipeline is moving rather than stuck. Any
 * more is history the summary line already reports, bought with rows of work
 * that has not happened yet.
 */
export const LEAD_CONTEXT_ROWS = 1;

/** Guard on the shrink loop; a plan is not worth an unbounded search. */
const MAX_SHRINK_STEPS = 2000;

export interface RunViewportPlan {
  /** Visible sibling count per list key. Absent keys fall back to {@link MAX_VISIBLE_LIST_ROWS}. */
  readonly caps: ReadonlyMap<string, number>;
  /** Rows the plan expects to draw. */
  readonly rows: number;
  /** Sibling rows hidden across every list. */
  readonly hidden: number;
  /** True when even the minimum plan overflows the budget. */
  readonly overflowing: boolean;
}

export const EMPTY_RUN_VIEWPORT_PLAN: RunViewportPlan = {
  caps: new Map(),
  rows: 0,
  hidden: 0,
  overflowing: false,
};

/** The cap a list draws with, given a plan that may not mention it. */
export function listCap(plan: RunViewportPlan, listKey: string): number {
  return plan.caps.get(listKey) ?? MAX_VISIBLE_LIST_ROWS;
}

/** The shape a row needs to be placed in a window; a real row carries far more. */
export interface StatusLike {
  readonly status: string;
}

/** Where a row sits relative to the work in flight. */
export type RowPhase = "settled" | "active" | "waiting";

const ACTIVE_STATUSES = new Set(["PROCESSING", "STREAMING", "ABORTING", "RUNNING"]);
const SETTLED_STATUSES = new Set(["COMPLETED", "FAILED", "ABORTED", "DISABLED"]);

/**
 * Read case-insensitively because two vocabularies reach this: a task reports
 * `PROCESSING` and a Map iteration slot reports `running`. Where a row goes on
 * screen is the same question for both, so it gets the same answer.
 */
export function rowPhase(status: string): RowPhase {
  const key = status.toUpperCase();
  if (ACTIVE_STATUSES.has(key)) return "active";
  if (SETTLED_STATUSES.has(key)) return "settled";
  return "waiting";
}

/** A list split into what is drawn and what is summarised at either end. */
export interface ListWindow<T> {
  readonly visible: readonly T[];
  /** Rows above the window — settled work, in the main. */
  readonly before: readonly T[];
  /** Rows below it — work that has not started, and any failure that sorts last. */
  readonly after: readonly T[];
}

const NOTHING: readonly never[] = [];

/**
 * Where a window of `size` rows starts, given where the work is.
 *
 * The anchor is the running rows. Everything before them has happened and
 * everything after them has not, so a window that holds them holds the only
 * rows whose glyphs are going to change. A span wider than the window keeps its
 * head: those started first and are the likeliest to finish next.
 *
 * With nothing running the anchor is the row that runs next, which is what a
 * graph looks like in the moment before it starts and between two steps. With
 * nothing left to run the window is the tail — the end of a finished list is
 * the last thing it did, and failures sort there.
 */
function windowStart<T extends StatusLike>(rows: readonly T[], size: number): number {
  let first = -1;
  let last = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rowPhase(rows[i].status) !== "active") continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0) {
    const next = rows.findIndex((row) => rowPhase(row.status) === "waiting");
    if (next < 0) return rows.length - size;
    first = next;
    last = next;
  }
  const span = last - first + 1;
  const lead = span >= size ? 0 : Math.min(LEAD_CONTEXT_ROWS, size - span, first);
  return Math.max(0, Math.min(first - lead, rows.length - size));
}

/**
 * The slice of a list that is drawn, and the rows held back above and below it.
 *
 * Hiding rows is only worth doing when it buys more rows than the lines
 * announcing them spend: a list one row over its cap would otherwise draw a
 * summary line saying "1 more" in the space that row would have occupied. At
 * the break-even point the real rows win.
 */
export function listWindow<T extends StatusLike>(rows: readonly T[], cap: number): ListWindow<T> {
  const whole: ListWindow<T> = { visible: rows, before: NOTHING, after: NOTHING };
  const size = Math.max(0, Math.min(Math.floor(cap), rows.length));
  if (size >= rows.length) return whole;
  // A list with no room left is one summary line, not two: there is no window
  // for the rows to be on either side of.
  if (size === 0) return { visible: NOTHING, before: rows, after: NOTHING };

  const start = windowStart(rows, size);
  const before = rows.slice(0, start);
  const after = rows.slice(start + size);
  const lines = (before.length > 0 ? 1 : 0) + (after.length > 0 ? 1 : 0);
  if (before.length + after.length <= lines) return whole;
  return { visible: rows.slice(start, start + size), before, after };
}

interface ListInfo {
  readonly list: CensusList;
  readonly depth: number;
}

function indexLists(root: CensusList): Map<string, ListInfo> {
  const out = new Map<string, ListInfo>();
  const walk = (list: CensusList, depth: number): void => {
    out.set(list.key, { list, depth });
    for (const node of list.nodes) {
      for (const child of node.lists) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function nodeRows(node: CensusNode, caps: Map<string, number>): number {
  let total = node.ownRows;
  for (const list of node.lists) total += listRows(list, caps);
  return total;
}

function listRows(list: CensusList, caps: Map<string, number>): number {
  const view = listWindow(list.nodes, caps.get(list.key) ?? MAX_VISIBLE_LIST_ROWS);
  let total = 0;
  for (const node of view.visible) total += nodeRows(node, caps);
  // Each line that says what was hidden is itself a row.
  if (view.before.length > 0) total += 1;
  if (view.after.length > 0) total += 1;
  return total;
}

/**
 * The lists the plan actually draws, following each list's own visible slice.
 *
 * A list hanging off a node the parent already capped away is not on screen,
 * so its cap decides nothing: shrinking it frees no row, and the siblings it
 * holds back are not rows anyone is missing. Both the victim search and the
 * hidden count walk this instead of every list in the tree — counting the whole
 * tree reported "193 hidden" for a plan whose drawn rows hid fourteen.
 */
function visibleListKeys(root: CensusList, caps: Map<string, number>): Set<string> {
  const keys = new Set<string>();
  const walk = (list: CensusList): void => {
    if (keys.has(list.key)) return;
    keys.add(list.key);
    const cap = caps.get(list.key) ?? MAX_VISIBLE_LIST_ROWS;
    for (const node of listWindow(list.nodes, cap).visible) {
      for (const child of node.lists) walk(child);
    }
  };
  walk(root);
  return keys;
}

function countHidden(root: CensusList, caps: Map<string, number>): number {
  const infos = indexLists(root);
  let hidden = 0;
  for (const key of visibleListKeys(root, caps)) {
    const info = infos.get(key);
    if (!info) continue;
    // From the window rather than from the cap: a list that kept every row
    // because the summary line was not worth its own space hides nothing.
    const view = listWindow(info.list.nodes, caps.get(key) ?? MAX_VISIBLE_LIST_ROWS);
    hidden += view.before.length + view.after.length;
  }
  return hidden;
}

/**
 * Chooses how many siblings each list shows so the tree fits `budget` rows.
 *
 * Deepest-first, widest-first among equals: the list that gives up a row is the
 * one whose rows are the most redundant with the rows around them. A list at
 * {@link MIN_VISIBLE_LIST_ROWS} is out of the running, which is what stops the
 * search from erasing a parent to save a child.
 */
export function planRunViewport(root: CensusList, budget: number): RunViewportPlan {
  const infos = indexLists(root);
  const caps = new Map<string, number>();
  for (const [key, info] of infos) {
    caps.set(key, Math.min(info.list.nodes.length, MAX_VISIBLE_LIST_ROWS));
  }

  let rows = listRows(root, caps);
  const limit = Math.max(1, budget);
  let steps = 0;

  while (rows > limit && steps++ < MAX_SHRINK_STEPS) {
    let victim: string | undefined;
    let victimDepth = -1;
    let victimCap = 0;
    // Only lists on screen are candidates: taking a row off a list nobody is
    // drawing costs a step and frees nothing, and with enough hidden subtrees
    // the search runs out of steps before it reaches a list that would help.
    for (const key of visibleListKeys(root, caps)) {
      const info = infos.get(key);
      if (!info) continue;
      const cap = caps.get(key) ?? 0;
      if (cap <= MIN_VISIBLE_LIST_ROWS) continue;
      if (info.depth > victimDepth || (info.depth === victimDepth && cap > victimCap)) {
        victim = key;
        victimDepth = info.depth;
        victimCap = cap;
      }
    }
    if (victim === undefined) break;
    caps.set(victim, victimCap - 1);
    rows = listRows(root, caps);
  }

  return {
    caps,
    rows,
    hidden: countHidden(root, caps),
    overflowing: rows > limit,
  };
}

/**
 * The height the live region holds this frame.
 *
 * Grows to whatever the content needs, never shrinks on its own, and is capped
 * by what the terminal can show. `held` coming back larger than `budget` is the
 * resize case — the window got shorter, and the region has to give the rows
 * back rather than scroll the prompt off the top.
 */
export function stickyRegionHeight(args: {
  readonly naturalRows: number;
  readonly heldRows: number;
  readonly budgetRows: number;
}): number {
  const budget = Math.max(0, Math.floor(args.budgetRows));
  const wanted = Math.max(Math.max(0, args.naturalRows), Math.max(0, args.heldRows));
  return Math.min(budget, wanted);
}

/**
 * Rows of content scrolled off the top of a tail-pinned region.
 *
 * A last resort, for the rows {@link planRunViewport} could not price — a
 * wrapped label, a subgraph drawn before the census saw it. It gives them back
 * off the top because each list's window already put the work in flight below
 * its settled context, so the top is the cheapest end to lose. The gutter is
 * what says rows went.
 */
export function tailScrollOffset(naturalRows: number, visibleRows: number): number {
  return Math.max(0, Math.floor(naturalRows) - Math.max(0, Math.floor(visibleRows)));
}

/** Track and thumb glyphs of the scroll gutter. Both are one cell wide in every font. */
export const SCROLL_TRACK_GLYPH = "│";
export const SCROLL_THUMB_GLYPH = "┃";

/**
 * A one-column scrollbar drawn beside a clipped region: one glyph per visible
 * row, a thumb whose length and position report how much is hidden and where
 * the view sits.
 *
 * The gutter rather than a summary line because it costs no rows — the thing in
 * shortest supply when content is being hidden in the first place — and because
 * it sits next to the rows it describes instead of at an edge the eye has to go
 * looking for.
 */
export function scrollGutter(args: {
  readonly totalRows: number;
  readonly visibleRows: number;
  readonly offsetRows: number;
}): string[] {
  const visible = Math.max(0, Math.floor(args.visibleRows));
  const total = Math.max(visible, Math.floor(args.totalRows));
  if (visible === 0) return [];
  if (total <= visible) return Array.from({ length: visible }, () => " ");

  const thumb = Math.max(1, Math.min(visible, Math.round((visible / total) * visible)));
  const maxOffset = total - visible;
  const offset = Math.max(0, Math.min(maxOffset, Math.floor(args.offsetRows)));
  const travel = visible - thumb;
  const top = travel === 0 ? 0 : Math.round((offset / maxOffset) * travel);

  return Array.from({ length: visible }, (_, i) =>
    i >= top && i < top + thumb ? SCROLL_THUMB_GLYPH : SCROLL_TRACK_GLYPH
  );
}

/** Marks a summary line for rows held back above the window. */
export const HIDDEN_ABOVE_GLYPH = "▲";

/** And below it — the two ends of a window need telling apart. */
export const HIDDEN_BELOW_GLYPH = "▼";

/**
 * What a truncated sibling list is not showing at one end, as one line.
 *
 * Reports by outcome rather than by position: "42 done" is the fact an operator
 * wants, and "rows 1–42" is the fact a scrollbar already carries. The glyph is
 * what says which end, since the same counts read very differently above the
 * window ("42 done" — work behind us) and below it ("6 more" — work to come).
 */
export function hiddenSiblingsLine(
  hiddenStatuses: readonly string[],
  glyph: string = HIDDEN_ABOVE_GLYPH
): string {
  if (hiddenStatuses.length === 0) return "";
  let done = 0;
  let failed = 0;
  let pending = 0;
  for (const status of hiddenStatuses) {
    if (status === "COMPLETED" || status === "DISABLED") done++;
    else if (status === "FAILED" || status === "ABORTED") failed++;
    else pending++;
  }
  const parts: string[] = [];
  if (done > 0) parts.push(`${done} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (pending > 0) parts.push(`${pending} more`);
  return `${glyph} ${parts.join(" · ")}`;
}
