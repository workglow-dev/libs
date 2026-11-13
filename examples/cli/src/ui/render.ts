/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The CLI's Ink surface, loaded on first use.
 *
 * Every function here forwards to {@link ./inkRender}, which is the only module
 * on the way to ink, react and `@inkjs/ui`. Importing this one costs nothing:
 * the renderer is loaded the first time a run UI or a prompt is drawn, which a
 * process without a terminal never does — a piped run, a run reporting to the
 * web console, `mcp serve`. Import the renderer from here, never from
 * `inkRender` directly, or the whole tree is back on the startup path.
 * `inkLazyLoad.test.ts` fails when an entry point reaches it statically.
 */

import type { IRunConfig, ITask, ITaskConstructor, TaskGraph } from "@workglow/task-graph";
import type { InputTaskConfig } from "@workglow/tasks";
import type { PromptFieldDescriptor } from "../input/prompt";
import type { SearchSelectAppProps, SearchSelectItem } from "./SearchSelectApp";

export type { SearchPage, SearchSelectItem } from "./SearchSelectApp";

export interface RenderOptions {
  readonly outputJsonFile?: string;
  /** When true, do not print JSON to stdout on success (TUI embed / library use). */
  readonly suppressResultOutput?: boolean;
}

export interface SchemaPromptRenderOptions {
  readonly initialFocusedFieldKey?: string;
}

/**
 * How a form that can also be refused came back. A refusal is not an empty
 * submission and not an abandonment, so it cannot be squeezed into
 * `values | undefined` — see {@link renderRefusableSchemaPrompt}.
 */
export type RefusableFormOutcome =
  | { readonly status: "submitted"; readonly values: Record<string, unknown> }
  | { readonly status: "declined" }
  | { readonly status: "cancelled" };

type InkRender = typeof import("./inkRender");

let inkRender: Promise<InkRender> | undefined;

function loadInkRender(): Promise<InkRender> {
  return (inkRender ??= import("./inkRender"));
}

export async function renderTaskRun(
  Ctor: ITaskConstructor<any, any, any>,
  input: Record<string, unknown>,
  opts: RenderOptions & { readonly config?: InputTaskConfig }
): Promise<void> {
  return (await loadInkRender()).renderTaskRun(Ctor, input, opts);
}

export async function renderWorkflowRun(
  graph: TaskGraph,
  input: Record<string, unknown>,
  opts: RenderOptions & {
    readonly config?: InputTaskConfig;
    readonly runExecutor?: () => Promise<unknown>;
  }
): Promise<unknown> {
  return (await loadInkRender()).renderWorkflowRun(graph, input, opts);
}

export async function renderTaskInstanceRun(
  task: ITask,
  taskType: string,
  opts: RenderOptions & {
    readonly overrides?: Record<string, unknown>;
    readonly runConfig?: Partial<IRunConfig>;
  }
): Promise<unknown> {
  return (await loadInkRender()).renderTaskInstanceRun(task, taskType, opts);
}

/**
 * The form, with the action row that lets a person refuse it.
 *
 * Separate from {@link renderSchemaPrompt} rather than a flag on it: the two
 * other callers offer no refusal, and widening their return type would make
 * them handle a case they cannot produce.
 */
export async function renderRefusableSchemaPrompt(
  fields: readonly PromptFieldDescriptor[],
  options?: SchemaPromptRenderOptions,
  signal?: AbortSignal
): Promise<RefusableFormOutcome> {
  return (await loadInkRender()).renderRefusableSchemaPrompt(fields, options, signal);
}

export async function renderSchemaPrompt(
  fields: readonly PromptFieldDescriptor[],
  options?: SchemaPromptRenderOptions,
  signal?: AbortSignal
): Promise<Record<string, unknown> | undefined> {
  return (await loadInkRender()).renderSchemaPrompt(fields, options, signal);
}

export async function renderSearchSelect<T extends SearchSelectItem>(
  props: Omit<SearchSelectAppProps<T>, "onSelect" | "onCancel">
): Promise<T | undefined> {
  return (await loadInkRender()).renderSearchSelect(props);
}

export async function renderSelectPrompt(
  options: Array<{ label: string; value: string }>,
  message?: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  return (await loadInkRender()).renderSelectPrompt(options, message, signal);
}
