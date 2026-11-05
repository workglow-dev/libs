/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { Entitlements } from "@workglow/task-graph";
import { describe, expect, it } from "vitest";
import { AiTask } from "../AiTask";

class ProbeAiTask extends AiTask {
  public static override type = "ProbeAiTask";
}

function modelResources(task: AiTask): readonly string[] | undefined {
  return task.entitlements().entitlements.find((e) => e.id === Entitlements.AI_MODEL)?.resources;
}

// The runner resolves a model id to its ModelConfig before the run-time entitlement
// check, so the requirement has to be read off the resolved object as well as a string.
describe("AiTask.entitlements scopes ai:model to the model the run uses", () => {
  it("names a model given as a string default", () => {
    const task = new ProbeAiTask({ defaults: { model: "openai:a" } } as never);
    expect(modelResources(task)).toEqual(["openai:a"]);
  });

  it("names a model that arrived as a resolved ModelConfig, with no default", () => {
    const task = new ProbeAiTask({} as never);
    task.runInputData.model = { model_id: "anthropic:b", provider: "anthropic" };
    expect(modelResources(task)).toEqual(["anthropic:b"]);
  });

  it("names the model the run uses, not the default it replaced", () => {
    const task = new ProbeAiTask({ defaults: { model: "openai:a" } } as never);
    task.runInputData.model = { model_id: "anthropic:b", provider: "anthropic" };
    expect(modelResources(task)).toEqual(["anthropic:b"]);
  });
});
