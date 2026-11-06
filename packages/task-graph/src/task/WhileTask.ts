/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DataPortSchema } from "@workglow/util/schema";
import { bridgeSubGraphTaskEvents } from "../task-graph/SubGraphEventBridge";
import { Workflow } from "../task-graph/Workflow";
import { CreateEndLoopWorkflow, CreateLoopWorkflow } from "../task-graph/WorkflowFactories";
import type { ComparisonOperator } from "./ConditionUtils";
import { conditionCompareValueError, evaluateCondition, getNestedValue } from "./ConditionUtils";
import type { GraphAsTaskConfig } from "./GraphAsTask";
import { GraphAsTask, graphAsTaskConfigSchema } from "./GraphAsTask";
import type { IExecuteContext, IRunConfig } from "./ITask";
import { resolveIterationBound, type IterationBound } from "./IteratorTask";
import type { StreamEvent, StreamFinish } from "./StreamTypes";
import { TaskAbortedError, TaskConfigurationError, TaskFailedError } from "./TaskError";
import type { TaskInput, TaskOutput, TaskTypeName } from "./TaskTypes";
import { WhileTaskRunner } from "./WhileTaskRunner";

/**
 * WhileTask context schema - only has index since count is unknown ahead of time.
 * Properties are marked with "x-ui-iteration": true so the builder
 * knows to hide them from parent-level display.
 */
export const WHILE_CONTEXT_SCHEMA: DataPortSchema = {
  type: "object",
  properties: {
    _iterationIndex: {
      type: "integer",
      minimum: 0,
      title: "Iteration Number",
      description: "Current iteration number (0-based)",
      "x-ui-iteration": true,
    },
  },
};

/**
 * Condition function type for WhileTask.
 * Receives the current output and iteration count, returns whether to continue looping.
 *
 * @param output - The output from the last iteration
 * @param iteration - The current iteration number (0-based)
 * @returns true to continue looping, false to stop
 */
export type WhileConditionFn<Output> = (output: Output, iteration: number) => boolean;

export const whileTaskConfigSchema = {
  type: "object",
  properties: {
    ...graphAsTaskConfigSchema["properties"],
    condition: {},
    maxIterations: {
      oneOf: [
        { type: "integer", minimum: 1 },
        { type: "string", const: "unbounded" },
      ],
    },
    chainIterations: { type: "boolean" },
    conditionField: { type: "string" },
    conditionOperator: { type: "string" },
    conditionValue: { type: "string" },
    iterationInputConfig: { type: "object", additionalProperties: true },
  },
  required: ["maxIterations"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type WhileTaskConfig<
  Input extends TaskInput = TaskInput,
  Output extends TaskOutput = TaskOutput,
> = GraphAsTaskConfig<Input> & {
  /**
   * Condition function that determines whether to continue looping.
   * Called after each iteration with the current output and iteration count.
   * Returns true to continue, false to stop.
   */
  readonly condition?: WhileConditionFn<Output>;

  /**
   * Upper bound on the number of iterations. Required — pass `"unbounded"` to
   * explicitly opt out of the safety ceiling, or a positive integer to cap.
   * Prevents infinite loops when the condition function can't disqualify
   * unbounded runaway input.
   */
  readonly maxIterations: IterationBound;

  /**
   * Whether to pass the output of each iteration as input to the next.
   * When true, output from iteration N becomes input to iteration N+1.
   * @default true
   */
  readonly chainIterations?: boolean;

  /** Output field to evaluate for the loop condition. */
  readonly conditionField?: string;

  /** Comparison operator for the loop condition. */
  readonly conditionOperator?: string;

  /** Value to compare against for the loop condition. */
  readonly conditionValue?: string;

  /** Per-property iteration input configuration (scalar/array/flexible). */
  readonly iterationInputConfig?: Record<string, { mode: string; baseSchema?: unknown }>;
};

/**
 * WhileTask loops until a condition function returns false.
 * Used for iterative refinement, polling, convergence, or conditional retry.
 * Output of each iteration is passed as input to the next when
 * `chainIterations` is set; `maxIterations` caps total iterations.
 */
export class WhileTask<
  Input extends TaskInput = TaskInput,
  Output extends TaskOutput = TaskOutput,
  Config extends WhileTaskConfig<Input, Output> = WhileTaskConfig<Input, Output>,
> extends GraphAsTask<Input, Output, Config> {
  public static override type: TaskTypeName = "WhileTask";
  public static override category: string = "Flow Control";
  public static override title: string = "While Loop";
  public static override description: string = "Loops until a condition function returns false";

  public static override hasDynamicSchemas: boolean = true;

  public static override configSchema(): DataPortSchema {
    return whileTaskConfigSchema;
  }

  constructor(config: Partial<Config> = {}, runConfig: Partial<IRunConfig> = {}) {
    if ((config as Partial<WhileTaskConfig<Input, Output>>).maxIterations === undefined) {
      throw new TaskConfigurationError(
        `${(new.target as typeof WhileTask).type ?? "WhileTask"}: maxIterations is required. ` +
          `Pass a positive integer to cap iteration, or "unbounded" to opt out explicitly.`
      );
    }
    super(config, runConfig);
  }

  /**
   * Returns the schema for iteration-context inputs that will be
   * injected into the subgraph InputTask at runtime.
   *
   * WhileTask only provides _iterationIndex since the total count
   * is unknown ahead of time.
   */
  public static getIterationContextSchema(): DataPortSchema {
    return WHILE_CONTEXT_SCHEMA;
  }

  protected _currentIteration: number = 0;

  public override canSerializeConfig(): boolean {
    return typeof this.config.condition !== "function";
  }

  // ========================================================================
  // TaskRunner Override
  // ========================================================================

  declare _runner: WhileTaskRunner<Input, Output, Config>;

  override get runner(): WhileTaskRunner<Input, Output, Config> {
    if (!this._runner) {
      this._runner = new WhileTaskRunner<Input, Output, Config>(this);
    }
    return this._runner;
  }

  // ========================================================================
  // Configuration Accessors
  // ========================================================================

  public get condition(): WhileConditionFn<Output> | undefined {
    return this.config.condition;
  }

  /**
   * Gets the maximum iterations limit, resolved to a numeric cap. The raw
   * `config.maxIterations` accepts `"unbounded"` as an explicit opt-out — that
   * sentinel resolves to `Number.POSITIVE_INFINITY` here so the loop logic can
   * compare against it directly.
   */
  public get maxIterations(): number {
    return resolveIterationBound(this.config.maxIterations);
  }

  public get chainIterations(): boolean {
    return this.config.chainIterations ?? true;
  }

  public get currentIteration(): number {
    return this._currentIteration;
  }

  // ========================================================================
  // Execution
  // ========================================================================

  /**
   * Builds a condition function from the serialized condition fields in config.
   */
  private buildConditionFromConfig(): WhileConditionFn<Output> | undefined {
    const { conditionOperator, conditionField, conditionValue } = this.config;

    if (!conditionOperator) {
      return undefined;
    }

    // A condition that can never be true ends the loop after its first pass, and the
    // run succeeds with that pass's output; refuse it before any pass runs.
    const invalid = conditionCompareValueError(
      conditionOperator as ComparisonOperator,
      conditionValue ?? ""
    );
    if (invalid) {
      throw new TaskConfigurationError(`${this.type}: loop condition can never hold: ${invalid}`);
    }

    return (output: Output) => {
      const fieldValue = conditionField
        ? getNestedValue(output as Record<string, unknown>, conditionField)
        : output;
      return evaluateCondition(fieldValue, conditionOperator as any, conditionValue ?? "");
    };
  }

  /**
   * Analyzes the iterationInputConfig from whileConfig to decompose
   * array inputs into per-iteration scalar values.
   *
   * Returns null if no iterationInputConfig is present (normal while behavior).
   */
  private analyzeArrayInputs(input: Input): {
    arrayPorts: string[];
    scalarPorts: string[];
    iteratedValues: Record<string, unknown[]>;
    iterationCount: number;
  } | null {
    if (!this.config.iterationInputConfig) {
      return null;
    }

    const inputData = input as Record<string, unknown>;
    const config = this.config.iterationInputConfig!;

    const arrayPorts: string[] = [];
    const scalarPorts: string[] = [];
    const iteratedValues: Record<string, unknown[]> = {};
    const arrayLengths: number[] = [];

    for (const [key, propConfig] of Object.entries(config)) {
      const value = inputData[key];

      if (propConfig.mode === "array") {
        if (!Array.isArray(value)) {
          // Skip non-array values for array-mode ports
          scalarPorts.push(key);
          continue;
        }
        iteratedValues[key] = value;
        arrayPorts.push(key);
        arrayLengths.push(value.length);
      } else {
        scalarPorts.push(key);
      }
    }

    // Also include any input keys not in the config as scalars
    for (const key of Object.keys(inputData)) {
      if (!config[key] && !key.startsWith("_iteration")) {
        scalarPorts.push(key);
      }
    }

    if (arrayPorts.length === 0) {
      return null;
    }

    // All array ports must have the same length (zip semantics)
    const uniqueLengths = new Set(arrayLengths);
    if (uniqueLengths.size > 1) {
      const lengthInfo = arrayPorts
        .map((port, index) => `${port}=${arrayLengths[index]}`)
        .join(", ");
      throw new TaskConfigurationError(
        `${this.type}: All iterated array inputs must have the same length. ` +
          `Found different lengths: ${lengthInfo}`
      );
    }

    return {
      arrayPorts,
      scalarPorts,
      iteratedValues,
      iterationCount: arrayLengths[0] ?? 0,
    };
  }

  /**
   * Builds per-iteration input by picking the i-th element from each array port
   * and passing scalar ports through unchanged.
   */
  private buildIterationInput(
    input: Input,
    analysis: {
      arrayPorts: string[];
      scalarPorts: string[];
      iteratedValues: Record<string, unknown[]>;
    },
    index: number
  ): Input {
    const inputData = input as Record<string, unknown>;
    const iterInput: Record<string, unknown> = {};

    for (const key of analysis.arrayPorts) {
      iterInput[key] = analysis.iteratedValues[key][index];
    }

    for (const key of analysis.scalarPorts) {
      if (key in inputData) {
        iterInput[key] = inputData[key];
      }
    }

    return iterInput as Input;
  }

  /**
   * Normalizes an error thrown by the user-supplied condition function.
   * A pre-typed {@link TaskFailedError} is rethrown unchanged so its type,
   * message, and stack survive; any other error is wrapped in a TaskFailedError
   * with the original stack chained on. Shared by execute() and executeStream()
   * so both paths preserve error type and stack identically.
   */
  private wrapConditionError(err: unknown): TaskFailedError {
    if (err instanceof TaskFailedError) {
      return err;
    }
    const message = `${this.type}: Condition function threw at iteration ${this._currentIteration}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    const wrappedError = new TaskFailedError(message);
    if (err instanceof Error && err.stack) {
      if (wrappedError.stack) {
        wrappedError.stack += `\nCaused by original error:\n${err.stack}`;
      } else {
        wrappedError.stack = err.stack;
      }
    }
    return wrappedError;
  }

  public override async execute(
    input: Input,
    context: IExecuteContext
  ): Promise<Output | undefined> {
    if (!this.hasChildren()) {
      throw new TaskConfigurationError(`${this.type}: No subgraph set for while loop`);
    }

    // Use provided condition or auto-build from serialized whileConfig
    const condition = this.condition ?? this.buildConditionFromConfig();

    if (!condition) {
      throw new TaskConfigurationError(`${this.type}: No condition function provided`);
    }

    // Check for array decomposition via iterationInputConfig
    const arrayAnalysis = this.analyzeArrayInputs(input);

    this._currentIteration = 0;
    let currentInput: Input = { ...input };
    let currentOutput: Output = {} as Output;

    // Determine effective max iterations (respect array length if decomposing)
    const effectiveMax = arrayAnalysis
      ? Math.min(this.maxIterations, arrayAnalysis.iterationCount)
      : this.maxIterations;

    /**
     * Blend the inner subgraph's aggregate `graph_progress` with the outer iteration
     * count so nested streaming tasks visibly advance the progress bar between iteration
     * boundaries. See {@link IteratorTaskRunner.executeSubgraphIteration} for the
     * equivalent pattern in `MapTask`. Capped at 99 because the loop may exit early
     * (condition can return false before hitting `effectiveMax`), mirroring the
     * boundary emit below.
     */
    const onInnerGraphProgress = (
      innerProgress: number | undefined,
      innerMessage?: string
    ): void => {
      if (innerProgress === undefined) return;
      const blended = Math.min(
        Math.round(((this._currentIteration + innerProgress / 100) / effectiveMax) * 100),
        99
      );
      const message = innerMessage
        ? `Iteration ${this._currentIteration + 1}/${effectiveMax}: ${innerMessage}`
        : `Iteration ${this._currentIteration + 1}/${effectiveMax}`;
      void context.updateProgress(blended, message);
    };
    const unsubscribeInnerProgress = this.subGraph.subscribe(
      "graph_progress",
      onInnerGraphProgress
    );

    // Bubble inner-task events up so subgraph children of a While loop surface
    // on the top-level stream (previews + progress). The same subGraph re-runs
    // per iteration, so bridge once and tear down in finally.
    const parentGraph = this.parentGraph;
    const unbridge = parentGraph ? bridgeSubGraphTaskEvents(this.subGraph, parentGraph) : () => {};

    try {
      // Execute iterations until condition returns false or max iterations reached
      while (this._currentIteration < effectiveMax) {
        if (context.signal?.aborted) {
          // Honor cancellation as a failure rather than returning the partial
          // currentOutput as a COMPLETED success.
          throw new TaskAbortedError(`${this.type}: aborted during iteration`);
        }

        // Build the input for this iteration
        let iterationInput: Input;
        if (arrayAnalysis) {
          // Decompose array inputs into per-iteration scalars
          iterationInput = {
            ...this.buildIterationInput(currentInput, arrayAnalysis, this._currentIteration),
            _iterationIndex: this._currentIteration,
          } as Input;
        } else {
          iterationInput = {
            ...currentInput,
            _iterationIndex: this._currentIteration,
          } as Input;
        }

        // Run the subgraph (it resets itself on each run)
        const results = await this.subGraph.run<Output>(iterationInput, {
          parentSignal: context.signal,
          // Each pass is a graph run of its own; it needs the run's registry and
          // enforcement flag, or every task inside is scheduled unchecked.
          ...this.runner.subGraphRunContext,
          enforceEntitlements: this.runConfig?.enforceEntitlements,
          ...this.runner.streamRunOptions,
        });

        // Merge results
        currentOutput = this.subGraph.mergeExecuteOutputsToRunOutput(
          results,
          this.compoundMerge
        ) as Output;

        // Check condition — wrap in try/catch so a throwing condition doesn't
        // leave the task in an inconsistent state without progress cleanup.
        let shouldContinue: boolean;
        try {
          shouldContinue = condition(currentOutput, this._currentIteration);
        } catch (err) {
          throw this.wrapConditionError(err);
        }
        if (!shouldContinue) {
          break;
        }

        // Chain output to input for next iteration if enabled
        if (this.chainIterations) {
          currentInput = { ...currentInput, ...currentOutput } as Input;
        }

        this._currentIteration++;

        // Boundary emit — coarse signal that iteration N/effectiveMax completed. Capped
        // at 99 since the loop may exit early; the task runner will emit 100 on completion.
        const progress = Math.min(Math.round((this._currentIteration / effectiveMax) * 100), 99);
        await context.updateProgress(
          progress,
          `Completed ${this._currentIteration}/${effectiveMax} iterations`
        );
      }
    } finally {
      unsubscribeInnerProgress();
      unbridge();
    }

    return currentOutput;
  }

  /**
   * Streaming execution for WhileTask: runs all iterations except the last
   * normally (materializing), then streams the final iteration's events.
   * This provides streaming output for the final result while still
   * supporting iteration chaining.
   */
  public override async *executeStream(
    input: Input,
    context: IExecuteContext
  ): AsyncIterable<StreamEvent<Output>> {
    if (!this.hasChildren()) {
      throw new TaskConfigurationError(`${this.type}: No subgraph set for while loop`);
    }

    const condition = this.condition ?? this.buildConditionFromConfig();
    if (!condition) {
      throw new TaskConfigurationError(`${this.type}: No condition function provided`);
    }

    const arrayAnalysis = this.analyzeArrayInputs(input);
    this._currentIteration = 0;
    let currentInput: Input = { ...input };
    let currentOutput: Output = {} as Output;

    const effectiveMax = arrayAnalysis
      ? Math.min(this.maxIterations, arrayAnalysis.iterationCount)
      : this.maxIterations;

    // Blend inner subgraph progress with outer iteration count; see execute() above.
    const onInnerGraphProgress = (
      innerProgress: number | undefined,
      innerMessage?: string
    ): void => {
      if (innerProgress === undefined) return;
      const blended = Math.min(
        Math.round(((this._currentIteration + innerProgress / 100) / effectiveMax) * 100),
        99
      );
      const message = innerMessage
        ? `Iteration ${this._currentIteration + 1}/${effectiveMax}: ${innerMessage}`
        : `Iteration ${this._currentIteration + 1}/${effectiveMax}`;
      void context.updateProgress(blended, message);
    };
    const unsubscribeInnerProgress = this.subGraph.subscribe(
      "graph_progress",
      onInnerGraphProgress
    );

    // Bubble inner-task events up so subgraph children of a While loop surface
    // on the top-level stream (previews + progress). The same subGraph re-runs
    // per iteration, so bridge once and tear down in finally.
    const parentGraph = this.parentGraph;
    const unbridge = parentGraph ? bridgeSubGraphTaskEvents(this.subGraph, parentGraph) : () => {};

    try {
      while (this._currentIteration < effectiveMax) {
        if (context.signal?.aborted) {
          throw new TaskAbortedError(`${this.type}: aborted during iteration`);
        }

        let iterationInput: Input;
        if (arrayAnalysis) {
          iterationInput = {
            ...this.buildIterationInput(currentInput, arrayAnalysis, this._currentIteration),
            _iterationIndex: this._currentIteration,
          } as Input;
        } else {
          iterationInput = {
            ...currentInput,
            _iterationIndex: this._currentIteration,
          } as Input;
        }

        // Check if the NEXT iteration would be the potential last: we always
        // run non-streaming first, then decide after the condition check.
        const results = await this.subGraph.run<Output>(iterationInput, {
          parentSignal: context.signal,
          // Each pass is a graph run of its own; it needs the run's registry and
          // enforcement flag, or every task inside is scheduled unchecked.
          ...this.runner.subGraphRunContext,
          enforceEntitlements: this.runConfig?.enforceEntitlements,
          ...this.runner.streamRunOptions,
        });

        currentOutput = this.subGraph.mergeExecuteOutputsToRunOutput(
          results,
          this.compoundMerge
        ) as Output;

        let shouldContinue: boolean;
        try {
          shouldContinue = condition(currentOutput, this._currentIteration);
        } catch (err) {
          throw this.wrapConditionError(err);
        }
        if (!shouldContinue) {
          // This was the final iteration -- but we already ran it non-streaming.
          // Emit the finish event with the collected output.
          break;
        }

        if (this.chainIterations) {
          currentInput = { ...currentInput, ...currentOutput } as Input;
        }

        this._currentIteration++;

        const progress = Math.min(Math.round((this._currentIteration / effectiveMax) * 100), 99);
        await context.updateProgress(
          progress,
          `Completed ${this._currentIteration}/${effectiveMax} iterations`
        );
      }
    } finally {
      unsubscribeInnerProgress();
      unbridge();
    }

    yield { type: "finish", data: currentOutput } as StreamFinish<Output>;
  }

  // ========================================================================
  // Schema Methods
  // ========================================================================

  public getIterationContextSchema(): DataPortSchema {
    return (this.constructor as typeof WhileTask).getIterationContextSchema();
  }

  /**
   * When chainIterations is true, the output schema from the previous
   * iteration becomes part of the input schema for the next iteration.
   * These chained properties should be marked with "x-ui-iteration": true.
   *
   * @returns Schema with chained output properties marked for iteration, or undefined if not chaining
   */
  public getChainedOutputSchema(): DataPortSchema | undefined {
    if (!this.chainIterations) return undefined;

    const outputSchema = this.outputSchema();
    if (typeof outputSchema === "boolean") return undefined;

    // Clone and mark all properties with x-ui-iteration
    const properties: Record<string, DataPortSchema> = {};
    if (outputSchema.properties && typeof outputSchema.properties === "object") {
      for (const [key, schema] of Object.entries(outputSchema.properties)) {
        // Skip the _iterations meta field
        if (key === "_iterations") continue;
        if (typeof schema === "object" && schema !== null) {
          properties[key] = { ...schema, "x-ui-iteration": true } as DataPortSchema;
        }
      }
    }

    if (Object.keys(properties).length === 0) return undefined;

    return { type: "object", properties } as DataPortSchema;
  }

  /**
   * Instance input schema override.
   * When iterationInputConfig is present, wraps array-mode ports in array schemas
   * so that the dataflow compatibility check accepts array values.
   */
  public override inputSchema(): DataPortSchema {
    if (!this.hasChildren()) {
      return (this.constructor as typeof WhileTask).inputSchema();
    }

    // Get the base schema from the subgraph (GraphAsTask behavior)
    const baseSchema = super.inputSchema();
    if (typeof baseSchema === "boolean") return baseSchema;

    if (!this.config.iterationInputConfig) {
      return baseSchema;
    }

    // Wrap array-mode ports in anyOf (scalar | array) schemas.
    // Using anyOf instead of plain type:"array" to avoid addInput's array-merge behavior
    // which would prepend an undefined element when runInputData starts empty.
    const properties = { ...(baseSchema.properties || {}) } as Record<string, DataPortSchema>;
    for (const [key, propConfig] of Object.entries(this.config.iterationInputConfig)) {
      if (propConfig.mode === "array" && properties[key]) {
        const scalarSchema = properties[key] as DataPortSchema;
        properties[key] = {
          anyOf: [scalarSchema, { type: "array", items: scalarSchema }],
        } as unknown as DataPortSchema;
      }
    }

    return {
      ...baseSchema,
      properties,
    } as DataPortSchema;
  }

  public static override inputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    } as const satisfies DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return {
      type: "object",
      properties: {
        _iterations: {
          type: "number",
          title: "Iterations",
          description: "Number of iterations executed",
        },
      },
      additionalProperties: true,
    } as const satisfies DataPortSchema;
  }

  public override outputSchema(): DataPortSchema {
    if (!this.hasChildren()) {
      return (this.constructor as typeof WhileTask).outputSchema();
    }

    // Get ending nodes from subgraph
    const tasks = this.subGraph.getTasks();
    const endingNodes = tasks.filter(
      (task) => this.subGraph.getTargetDataflows(task.id).length === 0
    );

    if (endingNodes.length === 0) {
      return (this.constructor as typeof WhileTask).outputSchema();
    }

    const properties: Record<string, unknown> = {
      _iterations: {
        type: "number",
        title: "Iterations",
        description: "Number of iterations executed",
      },
    };

    // Merge output schemas from ending nodes
    for (const task of endingNodes) {
      const taskOutputSchema = task.outputSchema();
      if (typeof taskOutputSchema === "boolean") continue;

      const taskProperties = taskOutputSchema.properties || {};
      for (const [key, schema] of Object.entries(taskProperties)) {
        if (!properties[key]) {
          properties[key] = schema;
        }
      }
    }

    return {
      type: "object",
      properties,
      additionalProperties: false,
    } as DataPortSchema;
  }
}

// ============================================================================
// Workflow Prototype Extensions
// ============================================================================

declare module "../task-graph/Workflow" {
  interface Workflow {
    /**
     * Starts a while loop that continues until a condition is false.
     * Use .endWhile() to close the loop and return to the parent workflow.
     */
    while: CreateLoopWorkflow<TaskInput, TaskOutput, WhileTaskConfig<TaskInput, any>>;

    /**
     * Ends the while loop and returns to the parent workflow.
     */
    endWhile(): Workflow;
  }
}

Workflow.prototype.while = CreateLoopWorkflow(WhileTask);
Workflow.prototype.endWhile = CreateEndLoopWorkflow("endWhile");
