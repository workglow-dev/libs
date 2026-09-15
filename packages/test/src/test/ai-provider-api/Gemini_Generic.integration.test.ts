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
import { GOOGLE_GEMINI } from "@workglow/google-gemini/ai";
import { registerGeminiInline } from "@workglow/google-gemini/ai-runtime";
import { setTaskQueueRegistry } from "@workglow/task-graph";
import { setLogger } from "@workglow/util";

import { getTestingLogger } from "@workglow/util/test";
import { runAiProviderConformance } from "@workglow/test-contract/ai-provider";

const RUN = !!process.env.GOOGLE_API_KEY || !!process.env.GEMINI_API_KEY;
// gemini-2.5-flash was retired from the v1beta API. Exercise a current
// "thinking" model so the thought-signature and structured-generation paths
// are covered live. The record pins an explicit thinking_budget: 3.5-flash
// spends ~90+ thought tokens even on trivial prompts and Gemini counts
// thoughts against maxOutputTokens, so without the budget padding the
// fixture's small maxTokens is consumed by thinking and the model returns
// MAX_TOKENS with no visible text (or tool call) at all.
const MODEL_ID = "gemini:gemini-3.8-flash";
const EMBED_MODEL_ID = "gemini:gemini-embedding-001";

runAiProviderConformance({
  name: "Google Gemini",
  skip: !RUN,
  timeout: 30_000,
  factory: async () => ({
    register: async () => {
      const logger = getTestingLogger();
      setLogger(logger);
      await setTaskQueueRegistry(null);
      setGlobalModelRepository(new InMemoryModelRepository());
      await registerGeminiInline();
      await getGlobalModelRepository().addModel({
        model_id: MODEL_ID,
        title: "Gemini 3.5 Flash",
        description: "Google Gemini 3.5 Flash",
        capabilities: ["text.generation", "text.rewriter", "text.summary", "tool-use", "json-mode"],
        provider: GOOGLE_GEMINI as typeof GOOGLE_GEMINI,
        provider_config: { model_name: "gemini-3.8-flash", thinking_budget: 1024 },
        metadata: {},
      });
      await getGlobalModelRepository().addModel({
        model_id: EMBED_MODEL_ID,
        title: "Gemini Embedding 001",
        description: "Google Gemini embedding model",
        capabilities: ["text.embedding"],
        provider: GOOGLE_GEMINI as typeof GOOGLE_GEMINI,
        provider_config: { model_name: "gemini-embedding-001" },
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
    structured: true,
    embeddings: true,
    sessions: false,
    abortMidStream: true,
  },
  models: {
    textGeneration: MODEL_ID,
    toolCalling: MODEL_ID,
    structured: MODEL_ID,
    embeddings: EMBED_MODEL_ID,
  },
});
