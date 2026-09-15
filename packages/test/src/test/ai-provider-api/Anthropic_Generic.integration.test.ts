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
import { ANTHROPIC } from "@workglow/anthropic/ai";
import { registerAnthropicInline } from "@workglow/anthropic/ai-runtime";
import { setTaskQueueRegistry } from "@workglow/task-graph";
import { setLogger } from "@workglow/util";

import { getTestingLogger } from "@workglow/util/test";
import { runAiProviderConformance } from "@workglow/test-contract/ai-provider";

const RUN = !!process.env.ANTHROPIC_API_KEY;
const MODEL_ID = "anthropic:claude-haiku";

runAiProviderConformance({
  name: "Anthropic",
  skip: !RUN,
  timeout: 30_000,
  factory: async () => ({
    register: async () => {
      const logger = getTestingLogger();
      setLogger(logger);
      await setTaskQueueRegistry(null);
      setGlobalModelRepository(new InMemoryModelRepository());
      await registerAnthropicInline();
      await getGlobalModelRepository().addModel({
        model_id: MODEL_ID,
        title: "Claude Haiku",
        description: "Anthropic Claude Haiku",
        capabilities: ["text.generation", "text.rewriter", "text.summary", "tool-use", "json-mode"],
        provider: ANTHROPIC as typeof ANTHROPIC,
        provider_config: { model_name: "claude-haiku-4-5-20251001" },
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
