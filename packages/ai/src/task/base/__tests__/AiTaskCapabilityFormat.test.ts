/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelConfig } from "@workglow/ai";
import { AiTask } from "@workglow/ai";
import { describe, expect, it } from "vitest";

/**
 * A model port may state the capabilities it needs instead of naming a task
 * whose `requires` implies them. The host's own `requires` is deliberately
 * narrower than the port's, so a test passing on it would prove nothing.
 */
class CapabilityPortTask extends AiTask<{ model: ModelConfig | string }> {
  public static override type = "CapabilityPortTask";
  public static override category = "Test";
  public static override requires = ["text.generation"] as const;
  public static override inputSchema() {
    return {
      type: "object",
      properties: {
        model: { format: "model:text.generation,tool-use" },
      },
      required: ["model"],
      additionalProperties: false,
    } as any;
  }
}

const model = (capabilities: string[]): ModelConfig =>
  ({
    model_id: "m",
    provider: "TEST",
    provider_config: { model_name: "m" },
    capabilities,
  }) as unknown as ModelConfig;

describe("AiTask model port stating capabilities", () => {
  it("refuses a model missing a capability the port lists", async () => {
    const task = new CapabilityPortTask({});
    await expect(task.validateInput({ model: model(["text.generation"]) })).rejects.toThrow(
      /Requires: \[text\.generation, tool-use\]/
    );
  });

  it("accepts a model holding every listed capability", async () => {
    const task = new CapabilityPortTask({});
    await expect(
      task.validateInput({ model: model(["text.generation", "tool-use"]) })
    ).resolves.toBe(true);
  });
});
