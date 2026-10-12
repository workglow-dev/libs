/** @jsxImportSource preact */
/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JSX } from "preact";
import { marqueeBar, unicodeBar } from "../../../ui/model/progressBar";
import type { RunTaskCounts } from "../../../ui/model/runCensus";
import {
  cliTaskStatusGlyph,
  deriveRunState,
  runAggregateProgress,
  runStatusBarModel,
  taskDetailText,
} from "../../../ui/model/runRowModel";
import { consoleContent, orderedRows, runLogText, type RunRow, type RunViewState } from "../state";
import { MapView } from "./MapView";

/** Braille frames, the same family the terminal spins. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** The most of a model's thinking a row keeps on screen; older text scrolls off. */
const REASONING_TAIL_CHARS = 600;

const RUNNING = new Set(["PROCESSING", "STREAMING", "ABORTING"]);

function durationOf(row: RunRow): number | undefined {
  if (row.startedAt === undefined || row.endedAt === undefined) return undefined;
  return Math.max(0, row.endedAt - row.startedAt);
}

function numberText(value: number): string {
  return value.toLocaleString("en-US");
}

function TaskRow({
  row,
  tick,
  state,
  selected,
  mapView,
  onSelect,
}: {
  row: RunRow;
  tick: number;
  state: RunViewState;
  selected: boolean;
  mapView: "rows" | "grid";
  onSelect: (id: string) => void;
}): JSX.Element {
  const running = RUNNING.has(row.status);
  const iteration = state.iterations.get(row.id);
  const detail = taskDetailText(row.progress, durationOf(row), running);
  const showBar = running && row.progress !== undefined;
  const indeterminate =
    running &&
    row.progress === undefined &&
    (row.streamText.length > 0 || row.reasoningText.length > 0);

  return (
    <div>
      <div
        className={`row d${Math.min(row.depth, 3)} st-${row.status}${selected ? " sel" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => onSelect(row.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") onSelect(row.id);
        }}
      >
        {row.depth > 0 ? <span className="guide" /> : null}
        <span className="gl">
          {running ? SPINNER[tick % SPINNER.length] : cliTaskStatusGlyph(row.status)}
        </span>
        <span className="lab">{row.label}</span>
        {running && row.message ? <span className="msg">— {row.message}</span> : null}
        <span className="bar">
          {showBar ? unicodeBar(row.progress ?? 0, 12) : indeterminate ? marqueeBar(tick, 12) : ""}
        </span>
        <span className="pct">{detail}</span>
      </div>
      {row.usage ? (
        <div className={`usage d${Math.min(row.depth, 2)}`}>
          <span className="up">↑ {numberText(row.usage.input)}</span>
          {"  "}
          <span className="dn">↓ {numberText(row.usage.output)}</span>
          {row.usage.cached ? `  ${numberText(row.usage.cached)} cached` : ""}
        </div>
      ) : null}
      {iteration ? <MapView taskId={row.id} map={iteration} tick={tick} view={mapView} /> : null}
      {row.reasoningText && !row.streamText && running ? (
        <div className={`bubble thinking d${Math.min(row.depth, 1)}`}>
          <div className="turn">
            <span className="r">thinking</span>
            <span className="txt">{row.reasoningText.slice(-REASONING_TAIL_CHARS)}</span>
            <span className="caret" />
          </div>
        </div>
      ) : null}
      {row.streamText && running ? (
        <div className={`bubble d${Math.min(row.depth, 1)}`}>
          <div className="turn">
            <span className="txt">{row.streamText.slice(-1200)}</span>
            <span className="caret" />
          </div>
        </div>
      ) : null}
      {row.status === "FAILED" && state.error ? (
        <div className={`err d${Math.min(row.depth, 1)}`}>{state.error}</div>
      ) : null}
    </div>
  );
}

export function RunConsole({
  cli,
  state,
  elapsedMs,
  tick,
  sortByStatus,
  selectedId,
  connected,
  mapView,
  onMapView,
  onSelect,
  onAbort,
  canAbort = true,
}: {
  cli: string;
  state: RunViewState;
  elapsedMs: number;
  tick: number;
  sortByStatus: boolean;
  selectedId: string | undefined;
  connected: boolean;
  mapView: "rows" | "grid";
  onMapView: (view: "rows" | "grid") => void;
  onSelect: (id: string) => void;
  onAbort: () => void;
  /** False while the CLI is not answering; the abort would reach nothing. */
  canAbort?: boolean;
}): JSX.Element {
  const rows = orderedRows(state, sortByStatus);
  const statuses = rows.map((row) => row.status);
  const runState = state.state === "running" ? deriveRunState(statuses) || "running" : state.state;
  const usage = state.usage;
  const usageText = usage ? `↑ ${numberText(usage.input)} ↓ ${numberText(usage.output)}` : "";
  // The console's rows already span every depth the run reports — owned
  // subgraphs and live Map clones arrive as `task_added` with a parent — so the
  // count is over all of them, matching what the terminal's census reports.
  const counts: RunTaskCounts = {
    done: statuses.filter((status) => status === "COMPLETED").length,
    total: rows.length,
    running: statuses.filter((status) => RUNNING.has(status)).length,
    failed: statuses.filter((status) => status === "FAILED" || status === "ABORTED").length,
    approximate: false,
  };
  // The clock lives in the screen header here, where the terminal has no room
  // for one; passing it again would print the same seconds twice.
  const fields = runStatusBarModel({
    usageLine: usageText,
    counts,
    state: runState,
    elapsedMs: undefined,
    hiddenRows: 0,
  }).fields;
  // The toggle only appears for a run that owns a map, and the grid only where
  // per-index state is retained — offering it otherwise would promise a view
  // the run cannot fill in.
  // Same rule the terminal's bar follows: `graph_progress` averages task
  // progresses that start at a zero nobody reported, so a run of tasks that
  // report nothing would sit at a measured-looking 0% for its whole life.
  const graphProgress = runAggregateProgress(state.graphProgress, rows);
  const gridable = [...state.iterations.values()].some((map) => map.slots !== undefined);
  const content = consoleContent(rows.length, state);

  return (
    <div className="wrap">
      <div className="screen">
        <div className="scr-head">
          <span
            className={`dot ${runState === "running" ? "run" : runState === "completed" ? "ok" : "fail"}`}
          />
          <span className="cli">
            $ <b>{cli}</b>
          </span>
          <span className="el">{(elapsedMs / 1000).toFixed(1)}s</span>
          {gridable ? (
            <>
              <span className="el">Map</span>
              <div className="seg">
                {(["rows", "grid"] as const).map((candidate) => (
                  <button
                    key={candidate}
                    aria-pressed={mapView === candidate}
                    onClick={() => onMapView(candidate)}
                  >
                    {candidate === "rows" ? "Rows" : "Grid"}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {state.state === "running" ? (
            <button
              className="ghost"
              onClick={onAbort}
              disabled={!canAbort}
              title={canAbort ? undefined : "the CLI is not responding"}
            >
              Abort
            </button>
          ) : null}
        </div>
        <div className="scr-body">
          {state.graphProgress !== undefined ? (
            <div className="gline">
              <span className="lb">Workflow</span>
              <span className="bar">
                {graphProgress === undefined ? marqueeBar(tick, 22) : unicodeBar(graphProgress, 22)}
              </span>
              <span className="pct">
                {graphProgress === undefined ? "" : `${Math.round(graphProgress)}%`}
              </span>
            </div>
          ) : null}
          {content === "waiting" ? (
            <div className="mapmore">
              {state.state === "running" ? "running…" : "this command printed nothing"}
            </div>
          ) : null}
          {content === "output" ? <pre className="scr-out">{runLogText(state)}</pre> : null}
          {content === "tasks"
            ? rows.map((row) => (
                <TaskRow
                  key={row.id}
                  row={row}
                  tick={tick}
                  state={state}
                  selected={selectedId === row.id}
                  mapView={mapView}
                  onSelect={onSelect}
                />
              ))
            : null}
        </div>
        <div className="scr-foot">
          <span>{runState}</span>
          {fields.map((field) => (
            <span key={field}>{field}</span>
          ))}
          {!connected && state.state === "running" ? <span>reconnecting…</span> : null}
        </div>
      </div>

      {content === "tasks" && state.logs.length > 0 ? (
        <div className="inspect">
          <div className="panel">
            <h5>
              <span>Command output</span>
            </h5>
            <pre className="json">{state.logs.map((log) => log.text).join("\n")}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
