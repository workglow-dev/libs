/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Capability,
  ModelConfig,
  ModelEffortPolicy,
  ModelPricing,
  ModelRecord,
} from "@workglow/ai";
import { AiProvider, FREE_LOCAL_PRICING } from "@workglow/ai";
import { createCloudProviderClass } from "@workglow/ai/provider-utils";
import { inferOllamaCapabilities, ollamaWorkerRunFnSpecs } from "./common/Ollama_Capabilities";
import { OLLAMA } from "./common/Ollama_Constants";
import { ollamaEffortPolicy } from "./common/Ollama_EffortPolicy";
import type { OllamaModelConfig } from "./common/Ollama_ModelSchema";

/** Main-thread registration (inline or worker-backed). No queue — uses direct execution. */
export class OllamaQueuedProvider extends createCloudProviderClass<OllamaModelConfig>(AiProvider, {
  name: OLLAMA,
  displayName: "Ollama",
  isLocal: true,
}) {
  override inferCapabilities(model: ModelRecord): readonly Capability[] {
    return inferOllamaCapabilities(model);
  }

  override modelPricing(model?: ModelConfig): ModelPricing | undefined {
    if (model && model.provider !== this.name && !model.model_id?.startsWith("ollama/")) {
      return undefined;
    }
    return FREE_LOCAL_PRICING;
  }

  override effortPolicy(model: OllamaModelConfig): ModelEffortPolicy | undefined {
    return ollamaEffortPolicy(model);
  }

  protected override workerRunFnSpecs(): readonly { serves: readonly Capability[] }[] {
    return ollamaWorkerRunFnSpecs();
  }
}
