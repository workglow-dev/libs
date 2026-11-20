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
import { META } from "@workglow/meta/ai";
import { registerMetaInline } from "@workglow/meta/ai-runtime";

import { getTestingLogger } from "@workglow/util/test";
import { runAiProviderConformance } from "@workglow/test-contract/ai-provider";

const RUN = !!(process.env.META_API_KEY || process.env.MODEL_API_KEY);
const MODEL_ID = "meta:muse-spark-1.3";

runAiProviderConformance({
  name: "Meta",
  skip: !RUN,
  timeout: 30_000,
  factory: async () => ({
    register: async () => {
      const logger = getTestingLogger();
      setLogger(logger);
      await setTaskQueueRegistry(null);
      setGlobalModelRepository(new InMemoryModelRepository());
      await registerMetaInline();
      await getGlobalModelRepository().addModel({
        model_id: MODEL_ID,
        title: "Muse Spark 1.3",
        description: "Meta Muse Spark 1.3",
        capabilities: ["text.generation", "text.rewriter", "text.summary", "tool-use", "json-mode"],
        provider: META as typeof META,
        provider_config: { model_name: "muse-spark-1.3" },
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
