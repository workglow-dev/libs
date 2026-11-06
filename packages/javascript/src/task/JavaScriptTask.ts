/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CachePolicy,
  IExecuteContext,
  TaskConfig,
  TaskEntitlements,
} from "@workglow/task-graph";
import {
  CreateWorkflow,
  Entitlements,
  Task,
  TaskAbortedError,
  TaskConfigSchema,
  TaskInvalidInputError,
  TaskRegistry,
  Workflow,
} from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";
import { Interpreter } from "./interpreter";

const isValidIdentifier = (key: string) => /^[a-z_$][\w$]*$/i.test(key);

/** How long the interpreter runs before letting the event loop take a turn. */
const SLICE_MS = 50;
/** Steps between clock reads; one step is far below a microsecond. */
const STEPS_PER_CLOCK_CHECK = 10_000;
/**
 * Default step budgets. A step count rather than a time limit, so a script stops at
 * the same point on every machine. ~9M steps run per second, so a run gets ~5 s and a
 * preview — which must be fast and has no abort signal — ~0.1 s.
 */
const DEFAULT_MAX_STEPS = 50_000_000;
const PREVIEW_MAX_STEPS = 1_000_000;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Runs the interpreter in time slices rather than with `Interpreter.run()`,
 * which is one synchronous loop: a script that never ended held the event loop
 * for good, so no timer, abort or UI update could run again. `run()` is itself
 * `while (step()) {}`, so slicing changes no result — only that other work, and
 * an abort, get a turn every {@link SLICE_MS}.
 */
async function runInSlices(
  interpreter: Interpreter,
  signal: AbortSignal | undefined,
  maxSteps: number
): Promise<void> {
  let sliceEnd = performance.now() + SLICE_MS;
  let steps = 0;
  while (interpreter.step()) {
    if (steps >= maxSteps) {
      throw new Error(`script did not finish within ${maxSteps} steps`);
    }
    if (++steps % STEPS_PER_CLOCK_CHECK !== 0 || performance.now() < sliceEnd) continue;
    await yieldToEventLoop();
    if (signal?.aborted) throw new TaskAbortedError("JavaScript execution aborted");
    sliceEnd = performance.now() + SLICE_MS;
  }
}

async function runJavaScript(
  input: JavaScriptTaskInput,
  configuredCode: string | undefined,
  signal: AbortSignal | undefined,
  maxSteps: number
): Promise<JavaScriptTaskOutput> {
  const output = {} as JavaScriptTaskOutput;
  const code = input.javascript_code || configuredCode;
  if (code) {
    try {
      const inputVariables = Object.keys(input)
        .filter((key) => key !== "javascript_code")
        .filter(isValidIdentifier);
      const inputVariablesString = inputVariables
        .map((key) => `var ${key} = ${JSON.stringify(input[key])};`)
        .join("\n");
      const myInterpreter = new Interpreter(`${inputVariablesString} ${code}`);
      await runInSlices(myInterpreter, signal, maxSteps);
      // The interpreter's value is a sandboxed pseudo-object for arrays/objects; callers
      // expect plain JS, so unwrap it. Primitives pass through untouched.
      output.output = myInterpreter.pseudoToNative(myInterpreter.value);
    } catch (e) {
      if (e instanceof TaskAbortedError) throw e;
      throw new TaskInvalidInputError(
        `JavaScript execution failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  return output;
}

const configSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    javascript_code: {
      type: "string",
      title: "Code",
      minLength: 1,
      description: "JavaScript code to execute",
      format: "code:javascript",
    },
    maxSteps: {
      type: "integer",
      minimum: 1,
      title: "Max Steps",
      description: `Interpreter steps a run may take before it is stopped (default ${DEFAULT_MAX_STEPS}); a preview takes at most ${PREVIEW_MAX_STEPS}`,
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

const inputSchema = {
  type: "object",
  properties: {
    javascript_code: {
      type: "string",
      title: "Code",
      minLength: 1,
      description: "JavaScript code to execute",
      format: "code:javascript",
    },
  },
  required: ["javascript_code"],
  additionalProperties: true,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    output: {
      title: "Output",
      description: "The output of the JavaScript code",
    },
  },
  required: ["output"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type JavaScriptTaskInput = FromSchema<typeof inputSchema>;
export type JavaScriptTaskOutput = FromSchema<typeof outputSchema>;
export type JavaScriptTaskConfig = TaskConfig & {
  javascript_code?: string;
  maxSteps?: number;
};

export class JavaScriptTask extends Task<
  JavaScriptTaskInput,
  JavaScriptTaskOutput,
  JavaScriptTaskConfig
> {
  public static override type = "JavaScriptTask";
  public static override category = "Utility";
  public static override title = "JavaScript Interpreter";
  public static override description =
    "Executes JavaScript code in a sandboxed interpreter environment";
  public static override customizable = true;

  /**
   * Not cached by default: the interpreter provides `Math.random()` and `Date.now()`,
   * so a script's output need not be a function of its input. A graph whose script is
   * pure opts in with `config.cacheable: true`; a run's `cacheable: false` still wins.
   */
  public static override cachePolicy: CachePolicy = { kind: "none" };

  public override getCachePolicy(input: JavaScriptTaskInput): CachePolicy {
    if (this.config?.cacheable === true && this.runConfig?.cacheable !== false) {
      return { kind: "deterministic" };
    }
    return super.getCachePolicy(input);
  }
  public static override hasDynamicSchemas = true;

  public static override entitlements(): TaskEntitlements {
    return {
      entitlements: [
        {
          id: Entitlements.CODE_EXECUTION_JS,
          reason: "Executes user-provided JavaScript code in a sandboxed interpreter",
        },
      ],
    };
  }

  public static override configSchema() {
    return configSchema;
  }

  public static override inputSchema() {
    return inputSchema;
  }

  public static override outputSchema() {
    return outputSchema;
  }

  public override inputSchema() {
    if (this.config?.javascript_code) {
      if (this.config.inputSchema) {
        return this.config.inputSchema;
      }
      return {
        type: "object",
        properties: {},
        additionalProperties: true,
      } as const satisfies DataPortSchema;
    }
    return inputSchema;
  }

  override async execute(input: JavaScriptTaskInput, context: IExecuteContext) {
    return runJavaScript(
      input,
      this.config.javascript_code,
      context.signal,
      this.config.maxSteps ?? DEFAULT_MAX_STEPS
    );
  }

  override async executePreview(input: JavaScriptTaskInput) {
    return runJavaScript(
      input,
      this.config.javascript_code,
      undefined,
      Math.min(this.config.maxSteps ?? PREVIEW_MAX_STEPS, PREVIEW_MAX_STEPS)
    );
  }
}

export const javaScript = (input: JavaScriptTaskInput, config: TaskConfig = {}) => {
  return new JavaScriptTask(config).run(input);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    javaScript: CreateWorkflow<JavaScriptTaskInput, JavaScriptTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.javaScript = CreateWorkflow(JavaScriptTask);

/**
 * Registers {@link JavaScriptTask} in the global {@link TaskRegistry} so
 * serialized graphs containing a `JavaScriptTask` node can be rehydrated.
 */
export function registerJavaScriptTasks(): void {
  TaskRegistry.registerTask(JavaScriptTask);
}
