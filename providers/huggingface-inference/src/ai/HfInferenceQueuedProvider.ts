/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelEffortPolicy, ModelRecord } from "@workglow/ai";
import { AiProvider } from "@workglow/ai";
import { createCloudProviderClass } from "@workglow/ai/provider-utils";
import {
  hfInferenceWorkerRunFnSpecs,
  inferHfInferenceCapabilities,
} from "./common/HFI_Capabilities";
import { HF_INFERENCE } from "./common/HFI_Constants";
import { hfiEffortPolicy } from "./common/HFI_EffortPolicy";
import type { HfInferenceModelConfig } from "./common/HFI_ModelSchema";

/** Main-thread registration (inline or worker-backed). No queue — uses direct execution. */
export class HfInferenceQueuedProvider extends createCloudProviderClass<HfInferenceModelConfig>(
  AiProvider,
  {
    name: HF_INFERENCE,
    displayName: "Hugging Face Inference",
  }
) {
  override inferCapabilities(model: ModelRecord): readonly Capability[] {
    return inferHfInferenceCapabilities(model);
  }

  override effortPolicy(model: HfInferenceModelConfig): ModelEffortPolicy | undefined {
    return hfiEffortPolicy(model);
  }

  protected override workerRunFnSpecs(): readonly { serves: readonly Capability[] }[] {
    return hfInferenceWorkerRunFnSpecs();
  }
}
