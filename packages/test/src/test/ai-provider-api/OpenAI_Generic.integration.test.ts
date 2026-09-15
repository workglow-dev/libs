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
import { OPENAI } from "@workglow/openai/ai";
import { registerOpenAiInline } from "@workglow/openai/ai-runtime";
import { setTaskQueueRegistry } from "@workglow/task-graph";
import { setLogger } from "@workglow/util";

import { getTestingLogger } from "@workglow/util/test";
import { runAiProviderConformance } from "@workglow/test-contract/ai-provider";

const RUN = !!process.env.OPENAI_API_KEY;
const MODEL_ID = "openai:gpt-4o-mini";
const EMBED_MODEL_ID = "openai:text-embedding-3-small";

runAiProviderConformance({
  name: "OpenAI",
  skip: !RUN,
  timeout: 30_000,
  factory: async () => ({
    register: async () => {
      const logger = getTestingLogger();
      setLogger(logger);
      await setTaskQueueRegistry(null);
      setGlobalModelRepository(new InMemoryModelRepository());
      await registerOpenAiInline();
      await getGlobalModelRepository().addModel({
        model_id: MODEL_ID,
        title: "GPT-4o Mini",
        description: "OpenAI GPT-4o Mini",
        capabilities: ["text.generation", "text.rewriter", "text.summary", "tool-use", "json-mode"],
        provider: OPENAI as typeof OPENAI,
        provider_config: { model_name: "gpt-4o-mini" },
        metadata: {},
      });
      await getGlobalModelRepository().addModel({
        model_id: EMBED_MODEL_ID,
        title: "Text Embedding 3 Small",
        description: "OpenAI text-embedding-3-small (1536D)",
        capabilities: ["text.embedding"],
        provider: OPENAI as typeof OPENAI,
        provider_config: { model_name: "text-embedding-3-small" },
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
