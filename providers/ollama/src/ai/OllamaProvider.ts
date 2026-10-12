/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { createCloudProviderClass } from "@workglow/ai/provider-utils";
import type { Capability, ModelEffortPolicy, ModelRecord } from "@workglow/ai/worker";
import { AiProvider } from "@workglow/ai/worker";
import { inferOllamaCapabilities, ollamaWorkerRunFnSpecs } from "./common/Ollama_Capabilities";
import { OLLAMA } from "./common/Ollama_Constants";
import { ollamaEffortPolicy } from "./common/Ollama_EffortPolicy";
import type { OllamaModelConfig } from "./common/Ollama_ModelSchema";

/**
 * Worker-server registration for Ollama. Imports `AiProvider` from
 * `@workglow/ai/worker` so the SDK is only loaded in the worker.
 *
 * Ollama runs locally and does not require an API key — only a `base_url`
 * (defaults to `http://localhost:11434`).
 */
export class OllamaProvider extends createCloudProviderClass<OllamaModelConfig>(AiProvider, {
  name: OLLAMA,
  displayName: "Ollama",
  isLocal: true,
}) {
  override inferCapabilities(model: ModelRecord): readonly Capability[] {
    return inferOllamaCapabilities(model);
  }

  override effortPolicy(model: OllamaModelConfig): ModelEffortPolicy | undefined {
    return ollamaEffortPolicy(model);
  }

  protected override workerRunFnSpecs(): readonly { serves: readonly Capability[] }[] {
    return ollamaWorkerRunFnSpecs();
  }
}
