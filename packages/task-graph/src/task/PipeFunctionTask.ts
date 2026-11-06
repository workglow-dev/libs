/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DataPortSchema } from "@workglow/util/schema";
import type { CachePolicy } from "../cache/CachePolicy";
import type { PipeFunction } from "../task-graph/Conversions";
import { registerPipeWrapperFactory } from "../task-graph/Conversions";
import { DATAFLOW_ALL_PORTS } from "../task-graph/Dataflow";
import type { IExecuteContext, ITask } from "./ITask";
import { Task } from "./Task";
import type { DataPorts } from "./TaskTypes";

/**
 * Wraps a plain function so it can take part in a graph.
 *
 * This lives here rather than in `Conversions.ts` because the class extends
 * `Task`, and `Conversions` is imported by `TaskRunner`, which is imported by
 * `Task` — so `Task` is still uninitialized while `Conversions` evaluates, and
 * an `extends` clause there resolves to `undefined`. Registering the factory
 * from this module defers the class definition until `Task` exists.
 *
 * A fresh subclass per call is deliberate: the wrapper's static `type` is
 * derived from the function's own name, so two different functions must not
 * share one class.
 */
function createPipeFunctionTask<I extends DataPorts, O extends DataPorts>(
  fn: PipeFunction<I, O>,
  config?: any
): ITask<I, O> {
  // Plain JS functions used inside `pipe()` cannot declare port schemas, so
  // the wrapper must accept (and emit) any object shape. An
  // `additionalProperties: false` here (alongside a single `[DATAFLOW_ALL_PORTS]`
  // ("*") property) makes the JSON-schema validator treat "*" as a literal key
  // and reject every real upstream port — e.g. `{ json, metadata }` from
  // `FetchUrlTask` — breaking any `pipe(task, async fn, ...)` chain with
  // TaskInvalidInputError. The runtime already handles the "*" wildcard in
  // `Task.addInput`; the schema just needs to permit the data through.
  class QuickTask extends Task<I, O> {
    public static override type = fn.name ? `𝑓 ${fn.name}` : "𝑓";
    public static override inputSchema = () => {
      return {
        type: "object",
        properties: {
          [DATAFLOW_ALL_PORTS]: {},
        },
        additionalProperties: true,
      } as const satisfies DataPortSchema;
    };
    public static override outputSchema = () => {
      return {
        type: "object",
        properties: {
          [DATAFLOW_ALL_PORTS]: {},
        },
        additionalProperties: true,
      } as const satisfies DataPortSchema;
    };
    public static override cachePolicy: CachePolicy = { kind: "none" };
    /**
     * The function this wraps cannot be written to JSON, and the per-call type it
     * gets is registered nowhere, so a saved graph naming it could never load.
     * Refused at save time -- as WhileTask and ConditionalTask holding functions are
     * -- rather than at the next load.
     */
    public override canSerializeConfig(): boolean {
      return false;
    }
    public override async execute(input: I, context: IExecuteContext) {
      return fn(input, context);
    }
  }
  return new QuickTask(config);
}

registerPipeWrapperFactory(createPipeFunctionTask);
