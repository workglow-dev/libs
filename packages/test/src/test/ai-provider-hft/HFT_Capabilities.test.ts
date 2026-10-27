/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { inferHftCapabilities } from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_Capabilities";
import { PipelineUseCase } from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_Constants";

const record = (model_id: string, provider_config: Record<string, unknown>) =>
  ({ model_id, provider_config, capabilities: [] }) as never;

describe("inferHftCapabilities from the pipeline a record loads with", () => {
  // Names none of the patterns know: only `pipeline` says what the model does.
  it.each([
    ["Xenova/nli-deberta-v3-xsmall", "zero-shot-classification", "text.classification"],
    [
      "onnx-community/grounding-dino-tiny-ONNX",
      "zero-shot-object-detection",
      "image.object-detection",
    ],
    ["Xenova/dinov2-small", "image-feature-extraction", "image.embedding"],
    ["Xenova/LaMini-Flan-T5-783M", "text2text-generation", "text.generation"],
  ])("serves %s loaded as %s with %s", (id, pipeline, capability) => {
    expect(inferHftCapabilities(record(id, { pipeline }))).toContain(capability);
  });

  it("gives an encoder-decoder model the text run-fns it can drive and nothing chat-shaped", () => {
    const caps = inferHftCapabilities(
      record("Xenova/LaMini-Flan-T5-783M", { pipeline: "text2text-generation" })
    );
    expect(caps).toEqual(expect.arrayContaining(["text.generation", "text.rewriter"]));
    for (const missing of ["tool-use", "json-mode", "cache.checkpoint", "session.dispose"]) {
      expect(caps).not.toContain(missing);
    }
  });

  it("reads the Hub's pipeline-task hint the same way", () => {
    expect(
      inferHftCapabilities(
        record("Xenova/flan-t5-small", { pipeline_task: "text2text-generation" })
      )
    ).toContain("text.generation");
  });

  // Rerankers and language detectors load `text-classification` too, so the
  // pipeline must not override what the name says.
  it("lets a name refine the pipeline it shares with others", () => {
    expect(
      inferHftCapabilities(record("Xenova/bge-reranker-base", { pipeline: "text-classification" }))
    ).toContain("text.reranking");
    expect(
      inferHftCapabilities(
        record("Xenova/xlm-roberta-base-language-detection", { pipeline: "text-classification" })
      )
    ).toContain("text.language-detection");
  });

  it("still falls through to meta-ops for a name and pipeline nothing serves", () => {
    expect(inferHftCapabilities(record("someone/mystery-model", {}))).toEqual([
      "model.search",
      "model.info",
    ]);
  });
});

describe("PipelineUseCase", () => {
  // A value the schema offers must be one a run-fn can drive: a model set to one
  // that nothing serves gets only meta capabilities and fails every task.
  it.each(["depth-estimation", "image-to-image", "document-question-answering"])(
    "does not offer %s, which no run-fn serves",
    (value) => {
      expect(Object.values(PipelineUseCase)).not.toContain(value);
    }
  );
});
