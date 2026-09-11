/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  IRunConfig,
  ITask,
  IWorkflow,
  TaskGraphRunConfig,
  WorkflowRunConfig,
} from "@workglow/task-graph";
import { TaskGraph } from "@workglow/task-graph";
import { projectRunEvents, projectTaskRunEvents } from "./run-events/projectRunEvents";
import type { RunEventSink } from "./run-events/runEventChannel";
import { ensureRunReporting } from "./run-events/runReporting";
import { detectCliTheme, setCliTheme } from "./terminal/detectTerminalTheme";
import { renderTaskInstanceRun, renderWorkflowRun } from "./ui/render";

/**
 * Runs while reporting to the event channel a parent process installed.
 *
 * This is the one place that decides, which is what makes every command in
 * every CLI built on this package reportable without being rewritten: they all
 * reach their graph through {@link withCli}.
 *
 * A successful graph reports a `result`, NOT a `run_end`. One command commonly
 * runs several graphs in sequence — `sync lists` rebuilds six tables, `sync
 * all` walks every leaf — and each of those reaches here separately. Ending
 * the run on the first one (and closing the channel behind it) is what made
 * `embarc-data sync lists` report two tasks and one table's row count for a
 * command that rebuilt six. The run ends when the PROCESS does, which the
 * parent already observes.
 *
 * A failure is different, and does end the run: it propagates out of the
 * command, so nothing further is coming, and the message is worth more than
 * the exit code the parent would otherwise synthesize.
 */
async function runReported<T>(
  sink: RunEventSink,
  attach: (sink: RunEventSink) => () => void,
  execute: () => Promise<T>
): Promise<T> {
  const stop = attach(sink);
  try {
    const result = await execute();
    sink.emit({ k: "result", output: result });
    return result;
  } catch (error) {
    const aborted =
      error instanceof Error && (/abort/i.test(error.name) || /abort/i.test(error.message));
    sink.emit({
      k: "run_end",
      state: aborted ? "aborted" : "failed",
      error: error instanceof Error ? error.message : String(error),
      output: undefined,
    });
    await sink.close();
    throw error;
  } finally {
    stop();
  }
}

function taskStaticType(task: ITask): string {
  const ctor = task.constructor as { type?: string };
  return typeof ctor.type === "string" ? ctor.type : "Task";
}

/**
 * Detects workflow-shaped values (graph + run) without importing the Workflow
 * class — and without `instanceof`, which asks whether the value came from THIS
 * copy of the package rather than whether it is a workflow. A downstream CLI
 * resolving its own `@workglow/task-graph` produces workflows this would
 * otherwise disown: they fell through to the single-task path, which happened
 * to work only because a workflow also has `run()`.
 */
function isGraphLike(value: unknown): value is TaskGraph {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as { getTasks?: unknown }).getTasks === "function" &&
    typeof (value as { run?: unknown }).run === "function"
  );
}

function isWorkflowLike(arg: unknown): arg is IWorkflow {
  return (
    arg != null &&
    typeof arg === "object" &&
    "graph" in arg &&
    isGraphLike((arg as { graph: unknown }).graph) &&
    "run" in arg &&
    typeof (arg as { run: unknown }).run === "function"
  );
}

/** Values that can be executed with CLI progress UI (TTY) or plain run when not a TTY. */
export type Tasklike = ITask | IWorkflow | TaskGraph;

export interface WithCliOptions {
  /** When true, do not print JSON to stdout on success (default for library-style callers). */
  readonly suppressResultOutput?: boolean;
  /**
   * Pass false when this run must not draw a terminal UI even on a TTY —
   * a command emitting JSON on stdout, say, which Ink's rows would interleave
   * with. Reporting to a watching parent is unaffected: that is a separate
   * question from whether a human is looking at this terminal, and answering
   * both with one flag is what made a piped run invisible to the console.
   */
  readonly interactive?: boolean;
}

/**
 * Operator opt-out from the terminal UI: `WORKGLOW_NO_TUI=1` runs plainly even
 * on a TTY, exactly as a piped run does.
 *
 * It exists because a run whose length is set by the size of the data can
 * accumulate memory in proportion to how many times it re-renders. Measured on
 * one `sync` sweep, same machine and database: 249 MB -> 1,148 MB across 3,000
 * filings with the UI on, flat at 297 MB with it off, and ~3x faster.
 *
 * The cause is NOT Ink, and this flag is the blunter of the two remedies.
 * React's DEVELOPMENT build instruments commits for the profiler, emitting
 * `performance.measure()` per component per commit; Node's user-timing buffer
 * is unbounded and nothing in a headless process drains it, so every entry is
 * retained for the process lifetime. A progress UI re-rendering continuously
 * for hours is simply the workload that makes an unbounded buffer visible.
 *
 * So prefer `NODE_ENV=production`, which drops the instrumentation entirely
 * and is also markedly faster; measured over 8,000 re-renders the heap stays
 * flat at ~15 MB and yoga node count never moves. Reach for this flag when the
 * production build is not an option, or when the terminal output itself is
 * unwanted — it works by removing the renders, which removes the accumulation
 * as a side effect rather than by fixing it.
 */
export function tuiDisabledByEnv(): boolean {
  const raw = process.env.WORKGLOW_NO_TUI?.trim().toLowerCase();
  return raw !== undefined && raw !== "" && raw !== "0" && raw !== "false";
}

export interface WithCliTaskHandle {
  readonly kind: "task";
  /**
   * `runConfig` reaches `task.run` and the Ink renderer alike — the
   * implementation has always threaded it, and the caller that needs it is one
   * running a task inside something longer than a command, where the registry
   * and the abort signal are the session's rather than the process's.
   */
  run(overrides?: Record<string, unknown>, runConfig?: Partial<IRunConfig>): Promise<unknown>;
  abort(): void;
}

export interface WithCliWorkflowHandle {
  readonly kind: "workflow";
  run(input?: Record<string, unknown>, config?: WorkflowRunConfig): Promise<unknown>;
  abort(): void;
}

export interface WithCliGraphHandle {
  readonly kind: "graph";
  run(input?: Record<string, unknown>, config?: TaskGraphRunConfig): Promise<unknown>;
  abort(): void;
}

export type WithCliHandle = WithCliTaskHandle | WithCliWorkflowHandle | WithCliGraphHandle;

function withCliTask(task: ITask, options?: WithCliOptions): WithCliTaskHandle {
  const suppressResultOutput = options?.suppressResultOutput ?? true;
  const interactive = (options?.interactive ?? true) && !tuiDisabledByEnv();
  return {
    kind: "task",
    abort: () => {
      task.abort();
    },
    run: async (
      overrides?: Record<string, unknown>,
      runConfig?: Partial<IRunConfig>
    ): Promise<unknown> => {
      const sink = ensureRunReporting();
      if (sink) {
        return runReported(
          sink,
          (s) => projectTaskRunEvents(task, s),
          () => task.run(overrides, runConfig)
        );
      }
      if (!interactive || !process.stdout.isTTY) {
        return task.run(overrides, runConfig);
      }

      setCliTheme(await detectCliTheme());

      const taskType = taskStaticType(task);

      return renderTaskInstanceRun(task, taskType, {
        suppressResultOutput,
        overrides,
        runConfig,
      });
    },
  };
}

function withCliWorkflow(workflow: IWorkflow, options?: WithCliOptions): WithCliWorkflowHandle {
  const suppressResultOutput = options?.suppressResultOutput ?? true;
  const interactive = (options?.interactive ?? true) && !tuiDisabledByEnv();
  return {
    kind: "workflow",
    abort: () => {
      workflow.graph.abort();
    },
    run: async (
      input: Record<string, unknown> = {},
      config?: WorkflowRunConfig
    ): Promise<unknown> => {
      const sink = ensureRunReporting();
      if (sink) {
        return runReported(
          sink,
          (s) => projectRunEvents(workflow.graph, s),
          () => workflow.run(input, config)
        );
      }
      if (!interactive || !process.stdout.isTTY) {
        return workflow.run(input, config);
      }

      setCliTheme(await detectCliTheme());

      return renderWorkflowRun(workflow.graph, input, {
        config: config as Record<string, unknown> | undefined,
        runExecutor: () => workflow.run(input, config),
        suppressResultOutput,
      });
    },
  };
}

function withCliGraph(graph: TaskGraph, options?: WithCliOptions): WithCliGraphHandle {
  const suppressResultOutput = options?.suppressResultOutput ?? true;
  const interactive = (options?.interactive ?? true) && !tuiDisabledByEnv();
  return {
    kind: "graph",
    abort: () => {
      graph.abort();
    },
    run: async (
      input: Record<string, unknown> = {},
      config?: TaskGraphRunConfig
    ): Promise<unknown> => {
      const sink = ensureRunReporting();
      if (sink) {
        return runReported(
          sink,
          (s) => projectRunEvents(graph, s),
          () => graph.run(input, config)
        );
      }
      if (!interactive || !process.stdout.isTTY) {
        return graph.run(input, config);
      }

      setCliTheme(await detectCliTheme());

      return renderWorkflowRun(graph, input, {
        config: config as Record<string, unknown> | undefined,
        runExecutor: () => graph.run(input, config),
        suppressResultOutput,
      });
    },
  };
}

export function withCli(task: ITask, options?: WithCliOptions): WithCliTaskHandle;
export function withCli(workflow: IWorkflow, options?: WithCliOptions): WithCliWorkflowHandle;
export function withCli(graph: TaskGraph, options?: WithCliOptions): WithCliGraphHandle;
export function withCli(tasklike: Tasklike, options?: WithCliOptions): WithCliHandle {
  if (isWorkflowLike(tasklike)) {
    return withCliWorkflow(tasklike, options);
  }
  if (tasklike instanceof TaskGraph || (isGraphLike(tasklike) && !("subGraph" in tasklike))) {
    return withCliGraph(tasklike as TaskGraph, options);
  }
  return withCliTask(tasklike, options);
}
