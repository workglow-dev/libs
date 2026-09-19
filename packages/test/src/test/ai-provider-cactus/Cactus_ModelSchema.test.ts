/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { CactusModelConfigSchema } from "@workglow/cactus/ai";
import { compileSchema } from "@workglow/util/schema";
import { describe, expect, it } from "vitest";

const validator = compileSchema(CactusModelConfigSchema);

describe("CactusModelConfigSchema", () => {
  it("accepts a minimal valid config", () => {
    const result = validator.validate({
      model_id: "needle-26m-test",
      title: "Needle",
      description: "",
      provider: "LOCAL_CACTUS",
      provider_config: { model_id: "needle-26m" },
      capabilities: ["tool-use"],
      metadata: {},
    });
    expect(result.valid).toBe(true);
  });

  it("accepts the Needle v2 catalog id", () => {
    const result = validator.validate({
      model_id: "needle-v2-test",
      title: "Needle 2",
      description: "",
      provider: "LOCAL_CACTUS",
      provider_config: { model_id: "needle-v2" },
      capabilities: ["tool-use"],
      metadata: {},
    });
    expect(result.valid).toBe(true);
  });

  it("accepts the Needle v3 catalog id", () => {
    const result = validator.validate({
      model_id: "needle-v3-test",
      title: "Needle 3",
      description: "",
      provider: "LOCAL_CACTUS",
      provider_config: { model_id: "needle-v3" },
      capabilities: ["tool-use"],
      metadata: {},
    });
    expect(result.valid).toBe(true);
  });

  it("rejects an unknown model_id", () => {
    const result = validator.validate({
      model_id: "x",
      title: "X",
      description: "",
      provider: "LOCAL_CACTUS",
      provider_config: { model_id: "not-a-real-model" },
      capabilities: ["tool-use"],
      metadata: {},
    });
    expect(result.valid).toBe(false);
  });

  it("rejects extra provider_config properties", () => {
    const result = validator.validate({
      model_id: "x",
      title: "X",
      description: "",
      provider: "LOCAL_CACTUS",
      provider_config: { model_id: "needle-26m", weights_url: "https://example.com" },
      capabilities: ["tool-use"],
      metadata: {},
    });
    expect(result.valid).toBe(false);
  });
});
