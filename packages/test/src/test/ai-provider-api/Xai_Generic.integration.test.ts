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
import { setTaskQueueRegistry } from "@workglow/task-graph";
import { setLogger } from "@workglow/util";
import { XAI } from "@workglow/xai/ai";
import { registerXaiInline } from "@workglow/xai/ai-runtime";

import { getTestingLogger } from "@workglow/util/test";
import { runAiProviderConformance } from "@workglow/test-contract/ai-provider";

const RUN = !!process.env.XAI_API_KEY;
const MODEL_ID = "xai:grok-3-mini";

runAiProviderConformance({
  name: "xAI",
  skip: !RUN,
  timeout: 30_000,
  factory: async () => ({
    register: async () => {
      const logger = getTestingLogger();
      setLogger(logger);
      await setTaskQueueRegistry(null);
      setGlobalModelRepository(new InMemoryModelRepository());
      await registerXaiInline();
      await getGlobalModelRepository().addModel({
        model_id: MODEL_ID,
        title: "Grok 3 Mini",
        description: "xAI Grok 3 Mini",
        capabilities: ["text.generation", "text.rewriter", "text.summary", "tool-use", "json-mode"],
        provider: XAI as typeof XAI,
        provider_config: { model_name: "grok-3-mini" },
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
