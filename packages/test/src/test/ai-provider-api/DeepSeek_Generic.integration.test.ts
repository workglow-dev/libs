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
import { DEEPSEEK } from "@workglow/deepseek/ai";
import { registerDeepSeekInline } from "@workglow/deepseek/ai-runtime";
import { setTaskQueueRegistry } from "@workglow/task-graph";
import { setLogger } from "@workglow/util";

import { getTestingLogger } from "@workglow/util/test";
import { runAiProviderConformance } from "@workglow/test-contract/ai-provider";

const RUN = !!process.env.DEEPSEEK_API_KEY;
// The cheaper of the two v4 tiers — the conformance suite only needs a model
// that can chat, call a tool, and emit json-mode output, not the strongest one.
const MODEL_ID = "deepseek:deepseek-v4-flash";

runAiProviderConformance({
  name: "DeepSeek",
  skip: !RUN,
  timeout: 30_000,
  factory: async () => ({
    register: async () => {
      const logger = getTestingLogger();
      setLogger(logger);
      await setTaskQueueRegistry(null);
      setGlobalModelRepository(new InMemoryModelRepository());
      await registerDeepSeekInline();
      await getGlobalModelRepository().addModel({
        model_id: MODEL_ID,
        title: "DeepSeek V4 Flash",
        description: "DeepSeek V4 Flash",
        capabilities: ["text.generation", "text.rewriter", "text.summary", "tool-use", "json-mode"],
        provider: DEEPSEEK as typeof DEEPSEEK,
        provider_config: { model_name: "deepseek-v4-flash" },
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
    // The DeepSeek chat models are text-only and the provider registers no
    // embedding run-fn, so these stay false.
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
