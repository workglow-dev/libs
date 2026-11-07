/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GraphAsTaskConfig,
  JsonTaskItem,
  TaskConfig,
  TaskGraphJson,
} from "@workglow/task-graph";
import {
  createGraphFromDependencyJSON,
  createGraphFromGraphJSON,
  CreateWorkflow,
  GraphAsTask,
  TaskInvalidInputError,
  taskGraphJsonShapeError,
  Workflow,
} from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";

const inputSchema = {
  type: "object",
  properties: {
    json: {
      type: "string",
      title: "JSON",
      description: "The JSON to parse",
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type JsonTaskInput = FromSchema<typeof inputSchema>;

const outputSchema = {
  type: "object",
  properties: {
    output: {
      title: "Output",
      description: "Output depends on the generated task graph",
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type JsonTaskOutput = FromSchema<typeof outputSchema>;

/**
 * JsonTask is a specialized task that creates and manages task graphs from JSON configurations.
 * It allows dynamic creation of task networks by parsing JSON definitions of tasks and their relationships.
 */
export class JsonTask<
  Input extends JsonTaskInput = JsonTaskInput,
  Output extends JsonTaskOutput = JsonTaskOutput,
  Config extends GraphAsTaskConfig<Input> = GraphAsTaskConfig<Input>,
> extends GraphAsTask<Input, Output, Config> {
  public static override type = "JsonTask";
  public static override category = "Hidden";
  public static override title = "JSON Task";
  public static override description =
    "A task that creates and manages task graphs from JSON configurations";

  public static override inputSchema() {
    return inputSchema;
  }

  public static override outputSchema() {
    return outputSchema;
  }

  /**
   * Regenerates the task subgraph from the current JSON input. Accepts either
   * a graph-format `{ tasks, dataflows }` or a dependency-format array.
   */
  public override regenerateGraph() {
    if (!this.runInputData.json) return;
    let data: TaskGraphJson | JsonTaskItem[] | JsonTaskItem;
    try {
      data = JSON.parse(this.runInputData.json);
    } catch (error) {
      throw new TaskInvalidInputError(
        `JsonTask: input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (
      data &&
      typeof data === "object" &&
      "tasks" in data &&
      Array.isArray((data as TaskGraphJson).tasks) &&
      "dataflows" in data &&
      Array.isArray((data as TaskGraphJson).dataflows)
    ) {
      // Checked before any task is constructed from it, so a malformed graph is
      // refused with the reason rather than failing somewhere inside construction.
      const shapeError = taskGraphJsonShapeError(data);
      if (shapeError !== undefined) {
        throw new TaskInvalidInputError(`JsonTask: graph JSON is malformed: ${shapeError}`);
      }
      this.subGraph = createGraphFromGraphJSON(data as TaskGraphJson, this.runConfig?.registry);
      super.regenerateGraph();
      return;
    }

    const jsonItems: JsonTaskItem[] = Array.isArray(data) ? data : [data as JsonTaskItem];
    this.subGraph = createGraphFromDependencyJSON(jsonItems, this.runConfig?.registry);
    super.regenerateGraph();
  }
}

export const json = (input: JsonTaskInput, config: TaskConfig = {}) => {
  return new JsonTask(config).run(input);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    json: CreateWorkflow<JsonTaskInput, JsonTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.json = CreateWorkflow(JsonTask);
