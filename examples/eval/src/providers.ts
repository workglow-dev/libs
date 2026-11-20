/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { registerAiTasks } from "@workglow/ai";
import { registerAnthropicInline } from "@workglow/anthropic/ai-runtime";
import { registerDeepSeekInline } from "@workglow/deepseek/ai-runtime";
import { registerGeminiInline } from "@workglow/google-gemini/ai-runtime";
import { registerHuggingFaceTransformers } from "@workglow/huggingface-transformers/ai";
import { registerMetaInline } from "@workglow/meta/ai-runtime";
import { registerLlamaCpp } from "@workglow/node-llama-cpp/ai";
import { registerOpenAiInline } from "@workglow/openai/ai-runtime";
import { registerBaseTasks, registerBuiltInTransforms } from "@workglow/task-graph";
import { EnvCredentialStore, setGlobalCredentialStore, Worker } from "@workglow/util";
import { registerXaiInline } from "@workglow/xai/ai-runtime";
import type { EvalConfig } from "./config";

/**
 * Register task types and every AI provider the eval can route to. Cloud
 * providers read their API keys from the environment (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, DEEPSEEK_API_KEY, META_API_KEY) at call time; the local
 * HuggingFace Transformers (ONNX) and node-llama-cpp (GGUF) providers run in
 * workers with their caches under the eval home. Each registration is
 * defensive: a provider that fails to load only fails runs that target it,
 * never the whole CLI.
 */
export async function registerEvalProviders(config: EvalConfig): Promise<void> {
  registerBaseTasks();
  registerAiTasks();
  registerBuiltInTransforms();
  setGlobalCredentialStore(new EnvCredentialStore());

  process.env.WORKGLOW_MODEL_CACHE = config.modelCache;

  const registrations: ReadonlyArray<[string, () => Promise<void>]> = [
    [
      "HF_TRANSFORMERS_ONNX",
      () =>
        registerHuggingFaceTransformers({
          // ".js" resolves in both modes: bun maps it to worker_hft.ts when running
          // from source, and the built dist contains worker_hft.js (a ".ts"
          // specifier would 404 in dist — bun build does not rewrite worker URLs).
          worker: () => new Worker(new URL("./worker_hft.js", import.meta.url), { type: "module" }),
        }),
    ],
    [
      "LOCAL_LLAMACPP",
      () =>
        registerLlamaCpp({
          worker: () =>
            new Worker(new URL("./worker_llamacpp.js", import.meta.url), { type: "module" }),
        }),
    ],
    ["ANTHROPIC", () => registerAnthropicInline()],
    ["OPENAI", () => registerOpenAiInline()],
    ["GOOGLE_GEMINI", () => registerGeminiInline()],
    ["XAI", () => registerXaiInline()],
    ["DEEPSEEK", () => registerDeepSeekInline()],
    ["META", () => registerMetaInline()],
  ];

  for (const [name, register] of registrations) {
    try {
      await register();
    } catch (err) {
      console.error(
        `warning: provider ${name} failed to register and its models will be unavailable: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
