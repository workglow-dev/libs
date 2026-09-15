/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { ImageEditTask, ImageGenerateTask } from "@workglow/ai";
import { registerHfInferenceInline } from "@workglow/huggingface-inference/ai-runtime";
import { beforeAll, describe, expect } from "vitest";

import { it } from "@workglow/test-contract/credit-exhausted-skip";

const RUN = !!process.env.HF_TOKEN;

describe.skipIf(!RUN)("HuggingFace Inference image generation (live)", () => {
  beforeAll(async () => {
    await registerHfInferenceInline();
  });

  it("generates an image with FLUX.1-schnell", async () => {
    const result = await new ImageGenerateTask({
      defaults: {
        prompt: "A red apple on a wooden table, photorealistic",
        model: {
          model_id: "black-forest-labs/FLUX.1-schnell",
          provider: "HF_INFERENCE",
          title: "",
          description: "",
          capabilities: ["image.generation"],
          provider_config: { model_name: "black-forest-labs/FLUX.1-schnell" },
          metadata: {},
        } as any,
        aspectRatio: "1:1",
        seed: 42,
      },
    }).run();
    expect(result.image.width).toBeGreaterThan(0);
    expect(result.image.height).toBeGreaterThan(0);
  }, 120_000);

  it("edits an image with FLUX.1-Kontext-dev (inpaint-capable)", async () => {
    const base = await new ImageGenerateTask({
      defaults: {
        prompt: "A blue sphere on a white background",
        model: {
          model_id: "black-forest-labs/FLUX.1-schnell",
          provider: "HF_INFERENCE",
          title: "",
          description: "",
          capabilities: ["image.generation"],
          provider_config: { model_name: "black-forest-labs/FLUX.1-schnell" },
          metadata: {},
        } as any,
        aspectRatio: "1:1",
        seed: 42,
      },
    }).run();
    const edited = await new ImageEditTask({
      defaults: {
        prompt: "Make the sphere green",
        image: base.image,
        model: {
          model_id: "black-forest-labs/FLUX.1-Kontext-dev",
          provider: "HF_INFERENCE",
          title: "",
          description: "",
          capabilities: ["image.editing"],
          provider_config: { model_name: "black-forest-labs/FLUX.1-Kontext-dev" },
          metadata: {},
        } as any,
        aspectRatio: "1:1",
      },
    }).run();
    expect(edited.image.width).toBeGreaterThan(0);
  }, 180_000);
});
