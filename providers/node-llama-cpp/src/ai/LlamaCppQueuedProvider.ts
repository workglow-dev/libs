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
  ModelPricing,
  ModelRecord,
} from "@workglow/ai";
import {
  FREE_LOCAL_PRICING,
  getAiProviderRegistry,
  noopEmit,
  QueuedAiProvider,
} from "@workglow/ai";
import type { TaskInput } from "@workglow/task-graph";
import {
  inferLlamaCppCapabilities,
  llamaCppWorkerRunFnSpecs,
} from "./common/LlamaCpp_Capabilities";
import { LOCAL_LLAMACPP } from "./common/LlamaCpp_Constants";
import { llamaCppEffortPolicy } from "./common/LlamaCpp_EffortPolicy";
import type { LlamaCppModelConfig } from "./common/LlamaCpp_ModelSchema";
import { deleteLlamaCppSession } from "./common/LlamaCpp_Runtime";

/** Main-thread registration (inline or worker-backed); creates the default job queue. */
export class LlamaCppQueuedProvider extends QueuedAiProvider<LlamaCppModelConfig> {
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

  override modelPricing(model?: ModelConfig): ModelPricing | undefined {
    if (
      model &&
      model.provider !== this.name &&
      !model.model_id?.startsWith("gguf:") &&
      !model.model_id?.endsWith(".gguf")
    ) {
      return undefined;
    }
    return FREE_LOCAL_PRICING;
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
    // In worker-backed registration the session map lives in the worker, so a
    // direct deleteLlamaCppSession here would silently no-op and leak the
    // worker's context-sequence slot. Dispatch through the registered
    // ["session.dispose"] run-fn — a worker proxy in worker mode, the local
    // run-fn inline — so the delete executes in the runtime that owns the map.
    const disposeFn = getAiProviderRegistry().getRunFnFor(this.name, ["session.dispose"]);
    if (disposeFn) {
      await disposeFn(
        {} as TaskInput,
        undefined,
        AbortSignal.timeout(30_000),
        noopEmit,
        undefined,
        { sessionId }
      );
      return;
    }

    // An unregistered inline provider still owns its session map in this runtime.
    await deleteLlamaCppSession(sessionId);
  }
}
