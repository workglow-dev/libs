/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DataPortSchema } from "@workglow/util/schema";
import { PROPERTY_ARRAY } from "../task-graph/TaskGraphRunner";
import { Workflow } from "../task-graph/Workflow";
import { CreateEndLoopWorkflow, CreateLoopWorkflow } from "../task-graph/WorkflowFactories";
import type { IRunConfig } from "./ITask";
import type { IteratorTaskConfig } from "./IteratorTask";
import { IteratorTask, iteratorTaskConfigSchema } from "./IteratorTask";
import type { TaskInput, TaskOutput, TaskTypeName } from "./TaskTypes";
export const mapTaskConfigSchema = {
  type: "object",
  properties: {
    ...iteratorTaskConfigSchema["properties"],
    preserveOrder: { type: "boolean" },
    flatten: { type: "boolean" },
    discardResults: { type: "boolean" },
  },
  required: iteratorTaskConfigSchema.required,
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type MapTaskConfig<Input extends TaskInput = TaskInput> = IteratorTaskConfig<Input> & {
  /**
   * Whether to preserve the order of results matching the input order.
   * When false, results may be in completion order.
   * @default true
   */
  readonly preserveOrder?: boolean;

  /**
   * Whether to flatten array results from each iteration.
   * When true, if each iteration returns an array, they are concatenated.
   * @default false
   */
  readonly flatten?: boolean;

  /**
   * When true, iteration results are discarded rather than collected into
   * per-property arrays. Used by the `.forEach()` workflow combinator for
   * side-effect-only loops where the caller does not need the return value.
   * @default false
   */
  readonly discardResults?: boolean;
};

/**
 * MapTask transforms one or more array inputs by running a workflow for each index.
 */
export class MapTask<
  Input extends TaskInput = TaskInput,
  Output extends TaskOutput = TaskOutput,
  Config extends MapTaskConfig<Input> = MapTaskConfig<Input>,
> extends IteratorTask<Input, Output, Config> {
  public static override type: TaskTypeName = "MapTask";
  public static override category: string = "Flow Control";
  public static override title: string = "Map";
  public static override description: string =
    "Transforms array inputs by running a workflow per item";

  public static override configSchema(): DataPortSchema {
    return mapTaskConfigSchema;
  }

  public static override readonly compoundMerge = PROPERTY_ARRAY;

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
      properties: {},
      additionalProperties: true,
    } as const satisfies DataPortSchema;
  }

  public get preserveOrder(): boolean {
    return this.config.preserveOrder ?? true;
  }

  public get flatten(): boolean {
    return this.config.flatten ?? false;
  }

  /**
   * Whether to drop iteration outputs rather than collect them. Used by
   * `.forEach()` for side-effect iteration.
   */
  public get discardResults(): boolean {
    return this.config.discardResults ?? false;
  }

  public override preserveIterationOrder(): boolean {
    return this.preserveOrder;
  }

  /** `.forEach()` discards results, so the runner need not retain them. */
  public override retainsIterationResults(): boolean {
    return !this.discardResults;
  }

  public override getEmptyResult(): Output {
    const schema = this.outputSchema();
    if (typeof schema === "boolean") {
      return {} as Output;
    }

    const result: Record<string, unknown[]> = {};
    for (const key of Object.keys(schema.properties || {})) {
      result[key] = [];
    }

    return result as Output;
  }

  /** Wraps inner workflow output properties in arrays. */
  public override outputSchema(): DataPortSchema {
    if (!this.hasChildren()) {
      return (this.constructor as typeof MapTask).outputSchema();
    }

    return this.getWrappedOutputSchema();
  }

  /**
   * Collects and optionally flattens results from all iterations. When
   * `discardResults` is set (via `.forEach()`), returns the empty result
   * without touching the per-iteration outputs.
   */
  public override collectResults(results: ReadonlyArray<TaskOutput | undefined>): Output {
    if (this.discardResults) {
      return this.getEmptyResult();
    }

    const collected = super.collectResults(results) as Record<string, unknown[]>;
    // A declared port no iteration produced still has one slot per item, as the empty
    // result does for no items.
    for (const key of Object.keys(this.getEmptyResult() as object)) {
      if (!(key in collected)) collected[key] = results.map(() => null);
    }

    if (!this.flatten) {
      return collected as Output;
    }

    const flattened: Record<string, unknown[]> = {};
    for (const [key, value] of Object.entries(collected)) {
      if (Array.isArray(value)) {
        flattened[key] = value.flat();
      } else {
        flattened[key] = value as unknown[];
      }
    }

    return flattened as Output;
  }
}

/**
 * ForEachTask is a `MapTask` variant that discards iteration results by default.
 * Used via the `.forEach()` workflow combinator for side-effect-only loops.
 */
export class ForEachTask<
  Input extends TaskInput = TaskInput,
  Output extends TaskOutput = TaskOutput,
  Config extends MapTaskConfig<Input> = MapTaskConfig<Input>,
> extends MapTask<Input, Output, Config> {
  public static override type: TaskTypeName = "ForEachTask";
  public static override title: string = "For Each";
  public static override description: string =
    "Runs a workflow per array item for side effects; discards collected results";

  constructor(config: Partial<Config> = {}, runConfig: Partial<IRunConfig> = {}) {
    super({ discardResults: true, ...config } as Partial<Config>, runConfig);
  }
}

// ============================================================================
// Workflow Prototype Extensions
// ============================================================================

declare module "../task-graph/Workflow" {
  interface Workflow {
    /**
     * Starts a map loop that transforms each element in array input ports.
     * Use .endMap() to close the loop and return to the parent workflow.
     */
    map: CreateLoopWorkflow<TaskInput, TaskOutput, MapTaskConfig<TaskInput>>;

    /**
     * Ends the map loop and returns to the parent workflow.
     */
    endMap(): Workflow;

    /**
     * Starts a forEach loop — iterates array input ports for side effects and
     * discards collected results. Use .endForEach() to close the loop and
     * return to the parent workflow. `maxIterations` is still required.
     */
    forEach: CreateLoopWorkflow<TaskInput, TaskOutput, MapTaskConfig<TaskInput>>;

    /**
     * Ends the forEach loop and returns to the parent workflow.
     */
    endForEach(): Workflow;
  }
}

Workflow.prototype.map = CreateLoopWorkflow(MapTask);
Workflow.prototype.endMap = CreateEndLoopWorkflow("endMap");
Workflow.prototype.forEach = CreateLoopWorkflow(ForEachTask);
Workflow.prototype.endForEach = CreateEndLoopWorkflow("endForEach");
