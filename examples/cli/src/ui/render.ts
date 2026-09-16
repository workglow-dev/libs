/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IRunConfig, ITask, ITaskConstructor, TaskGraph } from "@workglow/task-graph";
import type { InputTaskConfig } from "@workglow/tasks";
import { render } from "ink";
import React from "react";
import type { PromptFieldDescriptor } from "../input/prompt";
import { isAbortError } from "../run-signal-abort";
import { getCliTheme } from "../terminal/detectTerminalTheme";
import { formatError, outputResult } from "../util";
import { CliThemeProvider } from "./CliThemeContext";
import { ForwardCtrlCAsSigint } from "./ForwardCtrlCAsSigint";
import { releaseOnAbort } from "./promptAbort";
import { SchemaPromptApp } from "./SchemaPromptApp";
import type { SearchSelectAppProps, SearchSelectItem } from "./SearchSelectApp";
import { SearchSelectApp } from "./SearchSelectApp";
import { SelectPromptApp } from "./SelectPromptApp";
import { TaskRunApp } from "./TaskRunApp";
import { WorkflowRunApp } from "./WorkflowRunApp";

export type { SearchPage, SearchSelectItem } from "./SearchSelectApp";

function wrapWithCliTheme(node: React.ReactElement): React.ReactElement {
  return React.createElement(CliThemeProvider, {
    value: getCliTheme(),
    slot: node,
  });
}

/** Run UIs only: prompts keep Ink's default Ctrl-C = exit. */
function wrapRunUi(node: React.ReactElement): React.ReactElement {
  return wrapWithCliTheme(
    React.createElement(React.Fragment, null, React.createElement(ForwardCtrlCAsSigint), node)
  );
}

const RUN_INK_OPTIONS = { exitOnCtrlC: false } as const;

function failRun(
  instance: { clear(): void; unmount(): void },
  error: Error,
  reject: (reason: Error) => void
): void {
  instance.clear();
  instance.unmount();
  if (isAbortError(error)) {
    reject(error);
    return;
  }
  console.error(`\nError: ${formatError(error)}`);
  process.exit(1);
}

interface RenderOptions {
  readonly outputJsonFile?: string;
  /** When true, do not print JSON to stdout on success (TUI embed / library use). */
  readonly suppressResultOutput?: boolean;
}

export async function renderTaskRun(
  Ctor: ITaskConstructor<any, any, any>,
  input: Record<string, unknown>,
  opts: RenderOptions & { readonly config?: InputTaskConfig }
): Promise<void> {
  const task = new Ctor(opts.config ?? {}) as ITask;
  await renderTaskInstanceRun(task, Ctor.type, {
    outputJsonFile: opts.outputJsonFile,
    suppressResultOutput: opts.suppressResultOutput,
    overrides: input,
  });
}

export async function renderWorkflowRun(
  graph: TaskGraph,
  input: Record<string, unknown>,
  opts: RenderOptions & {
    readonly config?: InputTaskConfig;
    readonly runExecutor?: () => Promise<unknown>;
  }
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const onComplete = async (result: unknown) => {
      if (!opts.suppressResultOutput) {
        await outputResult(result, opts.outputJsonFile);
      }
      instance.clear();
      instance.unmount();
      resolve(result);
    };

    const onError = (error: Error) => {
      failRun(instance, error, reject);
    };

    const instance = render(
      wrapRunUi(
        React.createElement(WorkflowRunApp, {
          graph,
          input,
          config: opts.config,
          runExecutor: opts.runExecutor,
          onComplete,
          onError,
        })
      ),
      RUN_INK_OPTIONS
    );
  });
}

export async function renderTaskInstanceRun(
  task: ITask,
  taskType: string,
  opts: RenderOptions & {
    readonly overrides?: Record<string, unknown>;
    readonly runConfig?: Partial<IRunConfig>;
  }
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const onComplete = async (result: unknown) => {
      if (!opts.suppressResultOutput) {
        await outputResult(result, opts.outputJsonFile);
      }
      instance.clear();
      instance.unmount();
      resolve(result);
    };

    const onError = (error: Error) => {
      failRun(instance, error, reject);
    };

    const instance = render(
      wrapRunUi(
        React.createElement(TaskRunApp, {
          task,
          taskType,
          overrides: opts.overrides,
          runConfig: opts.runConfig,
          onComplete,
          onError,
        })
      ),
      RUN_INK_OPTIONS
    );
  });
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
  const values = await renderForm(fields, options, signal, true);
  if (values === DECLINED) return { status: "declined" };
  return values === undefined ? { status: "cancelled" } : { status: "submitted", values };
}

export async function renderSchemaPrompt(
  fields: readonly PromptFieldDescriptor[],
  options?: SchemaPromptRenderOptions,
  signal?: AbortSignal
): Promise<Record<string, unknown> | undefined> {
  const values = await renderForm(fields, options, signal, false);
  // Unreachable without `offerDecline`, and narrowed rather than cast so this
  // stops compiling if that ever stops being true.
  return values === DECLINED ? undefined : values;
}

/** Distinguishes a refusal from an abandonment inside {@link renderForm}. */
const DECLINED = Symbol("declined");

function renderForm(
  fields: readonly PromptFieldDescriptor[],
  options: SchemaPromptRenderOptions | undefined,
  signal: AbortSignal | undefined,
  offerDecline: boolean
): Promise<Record<string, unknown> | typeof DECLINED | undefined> {
  return new Promise<Record<string, unknown> | typeof DECLINED | undefined>((resolve) => {
    let detachAbort = (): void => {};
    const onComplete = (values: Record<string, unknown>) => {
      detachAbort();
      instance.clear();
      instance.unmount();
      resolve(values);
    };

    const onCancel = () => {
      detachAbort();
      instance.clear();
      instance.unmount();
      console.log("Cancelled.");
      resolve(undefined);
    };

    const onDecline = () => {
      detachAbort();
      instance.clear();
      instance.unmount();
      console.log("Declined.");
      resolve(DECLINED);
    };

    const instance = render(
      wrapWithCliTheme(
        React.createElement(SchemaPromptApp, {
          fields,
          onComplete,
          onCancel,
          // Absent unless asked for, which is what keeps the action row off the
          // forms whose callers have no refusal to report.
          onDecline: offerDecline ? onDecline : undefined,
          initialFocusedFieldKey: options?.initialFocusedFieldKey,
        })
      )
    );
    detachAbort = releaseOnAbort(signal, instance, resolve);
  });
}

export async function renderSearchSelect<T extends SearchSelectItem>(
  props: Omit<SearchSelectAppProps<T>, "onSelect" | "onCancel">
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const onSelect = (item: T) => {
      instance.clear();
      instance.unmount();
      const label = props.placeholder?.replace(/:$/, "") ?? "Selected";
      console.log(`\u2713 ${label}: ${item.label}`);
      resolve(item);
    };

    const onCancel = () => {
      instance.clear();
      instance.unmount();
      console.log("Cancelled.");
      resolve(undefined);
    };

    const instance = render(
      wrapWithCliTheme(
        React.createElement(SearchSelectApp as any, {
          ...props,
          onSelect,
          onCancel,
        })
      )
    );
  });
}

export async function renderSelectPrompt(
  options: Array<{ label: string; value: string }>,
  message?: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    let detachAbort = (): void => {};
    const onSelect = (value: string) => {
      detachAbort();
      instance.clear();
      instance.unmount();
      const label = message?.replace(/:$/, "") ?? "Selected";
      const option = options.find((o) => o.value === value);
      console.log(`\u2713 ${label}: ${option?.label ?? value}`);
      resolve(value);
    };

    const onCancel = () => {
      detachAbort();
      instance.clear();
      instance.unmount();
      console.log("Cancelled.");
      resolve(undefined);
    };

    const instance = render(
      wrapWithCliTheme(
        React.createElement(SelectPromptApp, {
          message,
          options,
          onSelect,
          onCancel,
        })
      )
    );
    detachAbort = releaseOnAbort(signal, instance, resolve);
  });
}
