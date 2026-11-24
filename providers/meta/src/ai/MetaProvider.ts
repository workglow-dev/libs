/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { createCloudProviderClass } from "@workglow/ai/provider-utils";
import type { Capability, ModelEffortPolicy, ModelRecord } from "@workglow/ai/worker";
import { AiProvider } from "@workglow/ai/worker";
import { inferMetaCapabilities, metaWorkerRunFnSpecs } from "./common/Meta_Capabilities";
import { META } from "./common/Meta_Constants";
import { metaEffortPolicy } from "./common/Meta_EffortPolicy";
import type { MetaModelConfig } from "./common/Meta_ModelSchema";

/**
 * Worker-server registration for Meta cloud models. Imports `AiProvider` from
 * `@workglow/ai/worker` so the SDK is only loaded in the worker.
 *
 * The class extends the {@link createCloudProviderClass} mixin (which supplies
 * `name` / `displayName` / `isLocal` / `supportsBrowser`) and adds the
 * Meta-specific {@link AiProvider.inferCapabilities} and
 * {@link AiProvider.workerRunFnSpecs} overrides.
 */
export class MetaProvider extends createCloudProviderClass<MetaModelConfig>(AiProvider, {
  name: META,
  displayName: "Meta",
}) {
  override inferCapabilities(model: ModelRecord): readonly Capability[] {
    return inferMetaCapabilities(model);
  }

  override effortPolicy(model: MetaModelConfig): ModelEffortPolicy | undefined {
    return metaEffortPolicy(model);
  }

  protected override workerRunFnSpecs(): readonly { serves: readonly Capability[] }[] {
    return metaWorkerRunFnSpecs();
  }
}
