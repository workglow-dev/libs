/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

export * from "./execution/DirectExecutionStrategy";
export * from "./execution/IAiExecutionStrategy";
export * from "./execution/QueuedExecutionStrategy";
export * from "./job/AiJob";
export * from "./model/InMemoryModelRepository";
export * from "./model/ModelRegistry";
export * from "./model/ModelRepository";
export * from "./model/ModelSchema";
export * from "./model/ModelPricing";
export * from "./model/ModelProfile";

export * from "./errors/ImageGenerationErrors";

export * from "./provider/AiProvider";
export * from "./provider/AiProviderRegistry";
// Explicit rather than `export *`: `clearCheckpointsForTesting` lives in this
// module and must NOT reach the public entry. It is routed through `_aiInternal`
// below and surfaced by the `./test` entry instead.
export {
  checkpointModelKey,
  deleteCheckpoint,
  getCheckpoint,
  getCheckpointUsageSink,
  registerCheckpoint,
  requireCheckpointModelKey,
  setCheckpointUsageSink,
} from "./provider/CheckpointRegistry";
export type {
  CheckpointEntry,
  CheckpointPrefix,
  CheckpointUsageSink,
} from "./provider/CheckpointRegistry";
export { cacheStorageUsage, disposeCheckpoint } from "./provider/CheckpointDisposal";
export * from "./provider/QueuedAiProvider";

export * from "./capability";
export * from "./kb/createStandardKbStrategy";
export * from "./task";

import { clearCheckpointsForTesting } from "./provider/CheckpointRegistry";
import { AiVisionTask } from "./task/base/AiVisionTask";

/**
 * @internal Plumbing for the `@workglow/ai/test` entry, which is the documented
 * surface. It must be reachable from this bundle so both entries share one module
 * instance — a separate bundle would get its own checkpoint registry, and a reset
 * there would clear a map nothing else reads. Import `@workglow/ai/test` instead.
 */
export const _aiInternal = {
  AiVisionTask,
  clearCheckpointsForTesting,
} as const;
