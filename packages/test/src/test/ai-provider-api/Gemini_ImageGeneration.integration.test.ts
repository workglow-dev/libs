/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { ImageEditTask, ImageGenerateTask } from "@workglow/ai";
import { registerGeminiInline } from "@workglow/google-gemini/ai-runtime";
import "@workglow/tasks";
import { beforeAll, describe, expect } from "vitest";

import { it } from "@workglow/test-contract/credit-exhausted-skip";

const RUN = !!process.env.GOOGLE_API_KEY || !!process.env.GEMINI_API_KEY;
const IMAGE_MODEL_ID = "gemini-2.5-flash-image";

describe.skipIf(!RUN)("Google Gemini image generation (live)", () => {
  beforeAll(async () => {
    await registerGeminiInline();
  });

  it("generates an image", async () => {
    const result = await new ImageGenerateTask({
      defaults: {
        prompt: "A red apple on a wooden table, photorealistic",
        model: {
          model_id: IMAGE_MODEL_ID,
          provider: "GOOGLE_GEMINI",
          title: "",
          description: "",
          capabilities: ["image.generation"],
          provider_config: { model_name: IMAGE_MODEL_ID },
          metadata: {},
        } as any,
        aspectRatio: "1:1",
        seed: 42,
      },
    }).run();
    expect(result.image.width).toBeGreaterThan(0);
    expect(result.image.height).toBeGreaterThan(0);
  }, 60_000);

  it("edits an image with prompt-only changes (no mask)", async () => {
    const base = await new ImageGenerateTask({
      defaults: {
        prompt: "A blue sphere on a white background",
        model: {
          model_id: IMAGE_MODEL_ID,
          provider: "GOOGLE_GEMINI",
          title: "",
          description: "",
          capabilities: ["image.generation"],
          provider_config: { model_name: IMAGE_MODEL_ID },
          metadata: {},
        } as any,
        aspectRatio: "1:1",
        seed: 42,
      },
    }).run();
    const edited = await new ImageEditTask({
      defaults: {
        prompt: "Make the sphere green",
        model: {
          model_id: IMAGE_MODEL_ID,
          provider: "GOOGLE_GEMINI",
          title: "",
          description: "",
          capabilities: ["image.editing"],
          provider_config: { model_name: IMAGE_MODEL_ID },
          metadata: {},
        } as any,
        aspectRatio: "1:1",
      },
    }).run({ image: base.image });
    expect(edited.image.width).toBeGreaterThan(0);
  }, 120_000);
});
