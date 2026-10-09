/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderPreviewRunFn,
  AiProviderRunFnRegistration,
  Capability,
  ModelConfig,
  ModelEffortPolicy,
  ModelRecord,
} from "@workglow/ai/worker";
import { AiProvider } from "@workglow/ai/worker";
import {
  inferLlamaCppCapabilities,
  llamaCppWorkerRunFnSpecs,
} from "./common/LlamaCpp_Capabilities";
import { LOCAL_LLAMACPP } from "./common/LlamaCpp_Constants";
import { llamaCppEffortPolicy } from "./common/LlamaCpp_EffortPolicy";
import type { LlamaCppModelConfig } from "./common/LlamaCpp_ModelSchema";
import { deleteLlamaCppSession } from "./common/LlamaCpp_Runtime";

/** Worker-server registration for node-llama-cpp (Node/Bun only — native binaries). */
export class LlamaCppProvider extends AiProvider<LlamaCppModelConfig> {
  readonly name = LOCAL_LLAMACPP;
  readonly displayName = "Local llama.cpp";
  readonly isLocal = true;
  readonly supportsBrowser = false;
  readonly supportsServer = true;

  constructor(
    promiseRunFns?: readonly AiProviderRunFnRegistration<any, any, LlamaCppModelConfig>[],
    previewTasks?: Record<string, AiProviderPreviewRunFn<any, any, LlamaCppModelConfig>>
  ) {
    super(promiseRunFns, previewTasks);
  }

  override inferCapabilities(model: ModelRecord): readonly Capability[] {
    return inferLlamaCppCapabilities(model);
  }

  override effortPolicy(model: LlamaCppModelConfig): ModelEffortPolicy | undefined {
    return llamaCppEffortPolicy(model);
  }

  protected override workerRunFnSpecs(): readonly { serves: readonly Capability[] }[] {
    return llamaCppWorkerRunFnSpecs();
  }

  override createSession(_model: ModelConfig): string {
    return crypto.randomUUID();
  }

  override async disposeSession(sessionId: string): Promise<void> {
    await deleteLlamaCppSession(sessionId);
  }
}
