/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelConfig } from "@workglow/ai";
import { AiImageOutputTask } from "@workglow/ai";
import type { ImageValue } from "@workglow/util/media";
import { describe, expect, it } from "vitest";

// Test subclass: overrides the abstract bits with concrete schemas.
class TestImageTask extends AiImageOutputTask<{
  prompt: string;
  model: ModelConfig | string;
  seed?: number;
  aspectRatio?: string;
}> {
  public static override type = "TestImageTask";
  public static override category = "Test";
  public static override inputSchema() {
    return {
      type: "object",
      properties: {
        prompt: { type: "string" },
        model: { type: "string", format: "model:TestImageTask" },
        seed: { type: "number" },
        aspectRatio: { type: "string" },
      },
      required: ["prompt", "model"],
      additionalProperties: false,
    } as any;
  }
}

function fakeImageValue(width = 8, height = 8, previewScale = 1): ImageValue {
  // Use a Node-shape ImageValue. Buffer + raw-rgba is the simplest construct
  // that survives `isImageValue`. The bytes are dummy — only structure matters.
  const buf = Buffer.alloc(width * height * 4);
  return { buffer: buf, format: "raw-rgba", width, height, previewScale } as ImageValue;
}

describe("AiImageOutputTask", () => {
  describe("seed-aware cache policy", () => {
    it("returns private cache policy when seed is undefined", () => {
      const task = new TestImageTask({});
      const policy = task.getCachePolicy({ prompt: "x", model: "m" });
      expect(policy).toEqual({ kind: "private" });
    });

    it("returns deterministic cache policy when seed is set", () => {
      const task = new TestImageTask({});
      const policy = task.getCachePolicy({ prompt: "x", model: "m", seed: 42 });
      expect(policy).toEqual({ kind: "deterministic" });
    });

    // Task.getCachePolicy's order: a caller's `cacheable: false` wins first. A seed
    // makes the output reproducible; it does not override the caller opting out.
    it("honours a caller's cacheable: false even when a seed is set", () => {
      const viaConfig = new TestImageTask({ cacheable: false } as never);
      expect(viaConfig.getCachePolicy({ prompt: "x", model: "m", seed: 42 })).toEqual({
        kind: "none",
      });
      const viaRunConfig = new TestImageTask({}, { cacheable: false } as never);
      expect(viaRunConfig.getCachePolicy({ prompt: "x", model: "m", seed: 42 })).toEqual({
        kind: "none",
      });
    });
  });

  describe("streaming accumulator (snapshot replacement)", () => {
    // Refcount-based retain/release on partials was deleted with the
    // ImageValue boundary refactor; ImageValue lifetime is JS GC. The
    // accumulator now just replaces `_latestPartial` on each ingest, and
    // `takeFinalPartial()` clears it without releasing. These tests verify
    // the new replacement semantics without referencing the deleted
    // retain/release API.
    it("replaces the prior partial when a new one is ingested", () => {
      const a = fakeImageValue();
      const b = fakeImageValue();
      const task = new TestImageTask({});
      (task as any).ingestPartial(a);
      expect((task as any)._latestPartial).toBe(a);
      (task as any).ingestPartial(b);
      expect((task as any)._latestPartial).toBe(b);
    });

    it("clears the buffer on takeFinalPartial without retaining", () => {
      const a = fakeImageValue();
      const task = new TestImageTask({});
      (task as any).ingestPartial(a);
      const out = (task as any).takeFinalPartial();
      expect(out).toBe(a);
      expect((task as any)._latestPartial).toBeUndefined();
    });
  });

  describe("preview without partial or prior", () => {
    it("returns undefined when there is nothing to preview, never calling a provider", async () => {
      const task = new TestImageTask({});
      task.runInputData = { prompt: "a sunset", model: "m" };
      const out = await task.executePreview({ prompt: "a sunset", model: "m" } as any, {
        own: ((x: any) => x) as any,
      });
      expect(out).toBeUndefined();
    });

    it("returns the latest partial when one is set", async () => {
      const partial = fakeImageValue();
      const task = new TestImageTask({});
      task.runInputData = { prompt: "x", model: "m" };
      (task as any).ingestPartial(partial);
      const out = await task.executePreview({ prompt: "x", model: "m" } as any, {
        own: ((x: any) => x) as any,
      });
      expect(out?.image).toBe(partial);
    });

    it("returns the prior run's image when no partial but runOutputData has one", async () => {
      const prior = fakeImageValue();
      const task = new TestImageTask({});
      task.runInputData = { prompt: "x", model: "m" };
      task.runOutputData = { image: prior } as any;
      const out = await task.executePreview({ prompt: "x", model: "m" } as any, {
        own: ((x: any) => x) as any,
      });
      expect(out?.image).toBe(prior);
    });
  });
});
