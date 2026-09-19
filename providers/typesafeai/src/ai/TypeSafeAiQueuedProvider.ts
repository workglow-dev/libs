/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelPricing, ModelRecord } from "@workglow/ai";
import { AiProvider } from "@workglow/ai";
import { createCloudProviderClass } from "@workglow/ai/provider-utils";
import {
  inferTypeSafeAiCapabilities,
  typeSafeAiWorkerRunFnSpecs,
} from "./common/TypeSafeAi_Capabilities";
import { TYPESAFEAI } from "./common/TypeSafeAi_Constants";
import type { TypeSafeAiModelConfig } from "./common/TypeSafeAi_ModelSchema";
import { getTypeSafeAiModelPricing } from "./common/TypeSafeAi_Pricing";

/**
 * Main-thread registration shell for TypeSafe. Used both for inline mode
 * (constructed with the run-fn registrations array) and worker-backed mode
 * (constructed empty so the base class registers worker proxies). No queue is
 * created — TypeSafe uses {@link DirectExecutionStrategy}.
 */
export class TypeSafeAiQueuedProvider extends createCloudProviderClass<TypeSafeAiModelConfig>(
  AiProvider,
  {
    name: TYPESAFEAI,
    displayName: "TypeSafe",
  }
) {
  override inferCapabilities(model: ModelRecord): readonly Capability[] {
    return inferTypeSafeAiCapabilities(model);
  }

  override modelPricing(model: TypeSafeAiModelConfig): ModelPricing | undefined {
    const modelName = (model.provider_config?.model_name as string | undefined) ?? model.model_id;
    return getTypeSafeAiModelPricing(modelName);
  }

  protected override workerRunFnSpecs(): readonly { serves: readonly Capability[] }[] {
    return typeSafeAiWorkerRunFnSpecs();
  }
}
