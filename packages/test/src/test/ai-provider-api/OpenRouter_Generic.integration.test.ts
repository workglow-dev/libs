/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getGlobalModelRepository,
  InMemoryModelRepository,
  setGlobalModelRepository,
} from "@workglow/ai";
import { OPENROUTER } from "@workglow/openrouter/ai";
import { registerOpenRouterInline } from "@workglow/openrouter/ai-runtime";
import { setTaskQueueRegistry } from "@workglow/task-graph";
import { setLogger } from "@workglow/util";

import { getTestingLogger } from "@workglow/util/test";
import { runAiProviderConformance } from "@workglow/test-contract/ai-provider";

const RUN = !!process.env.OPENROUTER_API_KEY;
// A cheap, tool- and json-capable model. OpenRouter ids are `vendor/model`.
const MODEL_ID = "openrouter:openai/gpt-4o-mini";

runAiProviderConformance({
  name: "OpenRouter",
  skip: !RUN,
  timeout: 30_000,
  factory: async () => ({
    register: async () => {
      const logger = getTestingLogger();
      setLogger(logger);
      await setTaskQueueRegistry(null);
      setGlobalModelRepository(new InMemoryModelRepository());
      await registerOpenRouterInline();
      await getGlobalModelRepository().addModel({
        model_id: MODEL_ID,
        title: "GPT-4o Mini (OpenRouter)",
        description: "openai/gpt-4o-mini via OpenRouter",
        capabilities: ["text.generation", "text.rewriter", "text.summary", "tool-use", "json-mode"],
        provider: OPENROUTER as typeof OPENROUTER,
        provider_config: { model_name: "openai/gpt-4o-mini" },
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
    embeddings: false,
    sessions: false,
    abortMidStream: true,
  },
  models: {
    textGeneration: MODEL_ID,
    toolCalling: MODEL_ID,
    structured: MODEL_ID,
  },
});
