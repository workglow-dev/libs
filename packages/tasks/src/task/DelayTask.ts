/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CachePolicy, IExecuteContext, TaskConfig } from "@workglow/task-graph";
import {
  CreateWorkflow,
  Task,
  TaskAbortedError,
  TaskConfigSchema,
  Workflow,
} from "@workglow/task-graph";
import { sleep } from "@workglow/util";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";

/**
 * Sleeps `ms`, or until `signal` aborts if that is sooner. The delay is slept in
 * chunks only to report progress; waking on the abort itself is what keeps a long
 * delay from noticing it a whole chunk (delay / 100) late.
 */
function sleepUntilAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

const delayTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    delay: {
      type: "number",
      title: "Delay (ms)",
      default: 1,
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type DelayTaskConfig = TaskConfig & {
  /** Delay duration in milliseconds */
  delay?: number;
};

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: true,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {},
  additionalProperties: true,
} as const satisfies DataPortSchema;

export type DelayTaskInput = FromSchema<typeof inputSchema>;
export type DelayTaskOutput = FromSchema<typeof outputSchema>;

export class DelayTask<
  Input extends DelayTaskInput = DelayTaskInput,
  Output extends DelayTaskOutput = DelayTaskOutput,
> extends Task<Input, Output, DelayTaskConfig> {
  static override readonly type = "DelayTask";
  static override readonly category = "Utility";
  public static override title = "Delay";
  public static override description =
    "Delays execution for a specified duration with progress tracking";
  public static override cachePolicy: CachePolicy = { kind: "none" };
  public static override passthroughInputsToOutputs = true;
  public static override customizable = true;

  public static override configSchema(): DataPortSchema {
    return delayTaskConfigSchema;
  }

  static override inputSchema() {
    return inputSchema;
  }

  static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, executeContext: IExecuteContext): Promise<Output> {
    const delay = this.config.delay ?? 1;
    if (delay > 100) {
      const iterations = Math.min(100, Math.floor(delay / 16));
      const chunkSize = delay / iterations;
      for (let i = 0; i < iterations; i++) {
        if (executeContext.signal.aborted) {
          throw new TaskAbortedError("Task aborted");
        }
        await sleepUntilAborted(chunkSize, executeContext.signal);
        if (executeContext.signal.aborted) {
          throw new TaskAbortedError("Task aborted");
        }
        await executeContext.updateProgress((100 * i) / iterations, `Delaying for ${delay}ms`);
      }
    } else {
      await sleep(delay);
    }
    return input as unknown as Output;
  }
}

export const delay = (input: DelayTaskInput, config: DelayTaskConfig = { delay: 1 }) => {
  const task = new DelayTask(config);
  return task.run(input);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    delay: CreateWorkflow<DelayTaskInput, DelayTaskOutput, DelayTaskConfig>;
  }
}

Workflow.prototype.delay = CreateWorkflow(DelayTask);
