/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getGlobalModelRepository,
  InMemoryModelRepository,
  setGlobalModelRepository,
} from "@workglow/ai";
import type { HfTransformersOnnxModelRecord } from "@workglow/huggingface-transformers/ai-runtime";
import {
  clearPipelineCache,
  HF_TRANSFORMERS_ONNX,
  registerHuggingFaceTransformersInline,
} from "@workglow/huggingface-transformers/ai-runtime";
import { setTaskQueueRegistry } from "@workglow/task-graph";
import { setLogger } from "@workglow/util";

import { getTestingLogger } from "@workglow/util/test";
import { runAiProviderConformance } from "@workglow/test-contract/ai-provider";

const TEXT_MODEL_ID = "onnx:onnx-community/Qwen2.5-1.5B-Instruct:q4";
const THINKING_MODEL_ID = "onnx:LiquidAI/LFM2.5-1.2B-Thinking-WebGPU:q4";
const INSTRUCT_MODEL_ID = "onnx:LiquidAI/LFM2.5-1.2B-Instruct-WebGPU:q4";
const EMBED_MODEL_ID = "onnx:Xenova/all-MiniLM-L6-v2:q8";

const textModel: HfTransformersOnnxModelRecord = {
  model_id: TEXT_MODEL_ID,
  title: "Qwen2.5-1.5B-Instruct",
  description: "Instruction-tuned model with native tool calling support",
  capabilities: ["text.generation", "json-mode"],
  provider: HF_TRANSFORMERS_ONNX,
  provider_config: {
    pipeline: "text-generation",
    model_path: "onnx-community/Qwen2.5-1.5B-Instruct",
    dtype: "q4",
    seed: 42,
  },
  metadata: {},
};

const instructModel: HfTransformersOnnxModelRecord = {
  model_id: INSTRUCT_MODEL_ID,
  title: "LFM2.5-1.2B-Instruct-WebGPU",
  description: "Liquid 1.2B Instruct WebGPU",
  capabilities: ["text.generation", "tool-use", "json-mode"],
  provider: HF_TRANSFORMERS_ONNX,
  provider_config: {
    pipeline: "text-generation",
    model_path: "LiquidAI/LFM2.5-1.2B-Instruct-ONNX",
    dtype: "q4",
    seed: 42,
  },
  metadata: {},
};

const thinkingModel: HfTransformersOnnxModelRecord = {
  model_id: THINKING_MODEL_ID,
  title: "LFM2.5-1.2B-Thinking-WebGPU",
  description: "Liquid 1.2B Thinking WebGPU",
  capabilities: ["text.generation", "tool-use", "json-mode"],
  provider: HF_TRANSFORMERS_ONNX,
  provider_config: {
    pipeline: "text-generation",
    model_path: "LiquidAI/LFM2.5-1.2B-Thinking-ONNX",
    dtype: "q4",
    seed: 42,
  },
  metadata: {},
};

const embeddingModel: HfTransformersOnnxModelRecord = {
  model_id: EMBED_MODEL_ID,
  title: "All-MiniLM-L6-v2 (384D)",
  description: "Sentence embedding model for the embeddings conformance assertion",
  capabilities: ["text.embedding"],
  provider: HF_TRANSFORMERS_ONNX,
  provider_config: {
    pipeline: "feature-extraction",
    model_path: "Xenova/all-MiniLM-L6-v2",
    native_dimensions: 384,
    dtype: "q8",
  },
  metadata: {},
};

runAiProviderConformance({
  name: "HFT (HuggingFace Transformers)",
  timeout: 300_000,
  factory: async () => ({
    register: async () => {
      const logger = getTestingLogger();
      setLogger(logger);
      await setTaskQueueRegistry(null);
      setGlobalModelRepository(new InMemoryModelRepository());
      await clearPipelineCache();
      await registerHuggingFaceTransformersInline();
      await getGlobalModelRepository().addModel(textModel);
      await getGlobalModelRepository().addModel(thinkingModel);
      await getGlobalModelRepository().addModel(instructModel);
      await getGlobalModelRepository().addModel(embeddingModel);
    },
    dispose: async () => {
      await setTaskQueueRegistry(null);
    },
    inspect: () => ({}),
  }),
  capabilities: {
    streaming: true,
    tools: true,
    structured: true,
    embeddings: true,
    sessions: true,
    abortMidStream: true,
  },
  models: {
    textGeneration: INSTRUCT_MODEL_ID,
    toolCalling: INSTRUCT_MODEL_ID,
    structured: INSTRUCT_MODEL_ID,
    embeddings: EMBED_MODEL_ID,
  },
  // Local ONNX inference is slow; relax the abort window so the
  // mid-stream-abort assertion has room to fire and shut down cleanly.
  fixture: { maxTokens: 2600, abortGraceMs: 500 },
});
