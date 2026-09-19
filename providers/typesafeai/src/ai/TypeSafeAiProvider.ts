/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { createCloudProviderClass } from "@workglow/ai/provider-utils";
import type { Capability, ModelPricing, ModelRecord } from "@workglow/ai/worker";
import { AiProvider } from "@workglow/ai/worker";
import {
  inferTypeSafeAiCapabilities,
  typeSafeAiWorkerRunFnSpecs,
} from "./common/TypeSafeAi_Capabilities";
import { TYPESAFEAI } from "./common/TypeSafeAi_Constants";
import type { TypeSafeAiModelConfig } from "./common/TypeSafeAi_ModelSchema";
import { getTypeSafeAiModelPricing } from "./common/TypeSafeAi_Pricing";

/**
 * Worker-server registration for TypeSafe cloud models. Imports `AiProvider`
 * from `@workglow/ai/worker` so the SDK is only loaded in the worker.
 *
 * The class extends the {@link createCloudProviderClass} mixin (which supplies
 * `name` / `displayName` / `isLocal` / `supportsBrowser`) and adds the
 * TypeSafe-specific {@link AiProvider.inferCapabilities} and
 * {@link AiProvider.workerRunFnSpecs} overrides.
 *
 * No `effortPolicy` override: Jev has no reasoning dial to turn. A policy
 * declaring efforts it does not honor would put a control in a UI that changes
 * nothing about the request.
 */
export class TypeSafeAiProvider extends createCloudProviderClass<TypeSafeAiModelConfig>(
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
