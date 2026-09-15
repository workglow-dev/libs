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
import { HF_INFERENCE } from "@workglow/huggingface-inference/ai";
import { registerHfInferenceInline } from "@workglow/huggingface-inference/ai-runtime";
import { setTaskQueueRegistry } from "@workglow/task-graph";
import { setLogger } from "@workglow/util";

import { getTestingLogger } from "@workglow/util/test";
import { runAiProviderConformance } from "@workglow/test-contract/ai-provider";

const RUN = !!process.env.HF_TOKEN;
// meta-llama/Llama-3.1-8B-Instruct is no longer routable via HF Inference
// ("no inference provider information for model"). Llama-3.3-70B-Instruct is
// broadly served; see the provider pin below for tool-calling support.
const MODEL_ID = "hf-inference:meta-llama/Llama-3.3-70B-Instruct";
const EMBED_MODEL_ID = "hf-inference:sentence-transformers/all-MiniLM-L6-v2";

runAiProviderConformance({
  name: "HuggingFace Inference",
  skip: !RUN,
  timeout: 60_000,
  factory: async () => ({
    register: async () => {
      const logger = getTestingLogger();
      setLogger(logger);
      await setTaskQueueRegistry(null);
      setGlobalModelRepository(new InMemoryModelRepository());
      await registerHfInferenceInline();
      await getGlobalModelRepository().addModel({
        model_id: MODEL_ID,
        title: "Llama 3.3 70B Instruct (HF Inference)",
        description: "Llama 3.3 70B Instruct via HuggingFace Inference API",
        capabilities: ["text.generation", "text.rewriter", "text.summary", "tool-use"],
        provider: HF_INFERENCE as typeof HF_INFERENCE,
        // Pin a router provider that supports tool calling for this model. The
        // default "auto" policy can route to backends that reject
        // `tools`/`tool_choice`.
        provider_config: { model_name: "meta-llama/Llama-3.3-70B-Instruct", provider: "together" },
        metadata: {},
      });
      await getGlobalModelRepository().addModel({
        model_id: EMBED_MODEL_ID,
        title: "All-MiniLM-L6-v2 (HF Inference)",
        description: "sentence-transformers/all-MiniLM-L6-v2 via HF Inference",
        capabilities: ["text.embedding"],
        provider: HF_INFERENCE as typeof HF_INFERENCE,
        provider_config: { model_name: "sentence-transformers/all-MiniLM-L6-v2" },
        metadata: {},
      });
    },
    dispose: async () => {
      await setTaskQueueRegistry(null);
    },
    inspect: () => ({}),
  }),
  capabilities: {
    streaming: true,
    tools: true,
    structured: false,
    embeddings: true,
    sessions: false,
    abortMidStream: true,
  },
  models: {
    textGeneration: MODEL_ID,
    toolCalling: MODEL_ID,
    embeddings: EMBED_MODEL_ID,
  },
});
