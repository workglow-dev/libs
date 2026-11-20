/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelEffortPolicy, ModelPricing, ModelRecord } from "@workglow/ai";
import { AiProvider } from "@workglow/ai";
import { createCloudProviderClass } from "@workglow/ai/provider-utils";
import { inferMetaCapabilities, metaWorkerRunFnSpecs } from "./common/Meta_Capabilities";
import { META } from "./common/Meta_Constants";
import { metaEffortPolicy } from "./common/Meta_EffortPolicy";
import type { MetaModelConfig } from "./common/Meta_ModelSchema";
import { getMetaModelPricing } from "./common/Meta_Pricing";

/**
 * Main-thread registration shell for Meta. Used both for inline mode
 * (constructed with the run-fn registrations array) and worker-backed mode
 * (constructed empty so the base class registers worker proxies). No queue is
 * created — Meta uses {@link DirectExecutionStrategy}.
 */
export class MetaQueuedProvider extends createCloudProviderClass<MetaModelConfig>(AiProvider, {
  name: META,
  displayName: "Meta",
}) {
  override inferCapabilities(model: ModelRecord): readonly Capability[] {
    return inferMetaCapabilities(model);
  }

  override effortPolicy(model: MetaModelConfig): ModelEffortPolicy | undefined {
    return metaEffortPolicy(model);
  }

  override modelPricing(model: MetaModelConfig): ModelPricing | undefined {
    const modelName = (model.provider_config?.model_name as string | undefined) ?? model.model_id;
    return getMetaModelPricing(modelName);
  }

  protected override workerRunFnSpecs(): readonly { serves: readonly Capability[] }[] {
    return metaWorkerRunFnSpecs();
  }
}
