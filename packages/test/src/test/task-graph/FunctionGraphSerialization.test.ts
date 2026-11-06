/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IWorkflow, PipeFunction } from "@workglow/task-graph";
import { parallel, pipe, TaskSerializationError, Workflow } from "@workglow/task-graph";
import { describe, expect, it } from "vitest";

// A function step is minted as an unregistered class per call, so its JSON names a type
// nothing can load. WhileTask and ConditionalTask holding functions refuse at save
// time; a graph built from functions now does too, instead of failing at the next load.
describe("graphs built from functions", () => {
  type Ports = { n: number };
  // Typed up front: inferring these generics through every pipe() overload costs the
  // checker over 100k instantiations for a test that only needs a function step.
  const double: PipeFunction<Ports, Ports> = async function double(input) {
    return { n: input.n * 2 };
  };
  const empty = (): IWorkflow<Ports, Ports> => new Workflow<Ports, Ports>();

  it("refuse to serialize a pipe() function step", () => {
    const workflow = pipe<Ports, Ports>([double]);
    expect(() => workflow.graph.toJSON()).toThrow(TaskSerializationError);
  });

  it("refuse to serialize a parallel() group", () => {
    const workflow = parallel<Ports, Ports>([double, empty()]);
    expect(() => workflow.graph.toJSON()).toThrow(TaskSerializationError);
  });

  it("label a parallel group by what each branch is, not 𝑓 for all of them", () => {
    const workflow = parallel<Ports, Ports>([double, empty()]);
    expect(workflow.graph.getTasks()[0]!.type).toBe("‖𝑓 double‖Workflow‖");
  });
});
