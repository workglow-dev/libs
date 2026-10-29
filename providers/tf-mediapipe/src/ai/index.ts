/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

export * from "./common/TFMP_Constants";
export * from "./common/TFMP_ModelSchema";
export * from "./common/TFMP_ModelSearch";
export * from "./registerTensorFlowMediaPipe";
// Type only. The base-URL accessors deliberately are NOT re-exported here:
// `./ai` and `./ai-runtime` are separate bundler entry points with no shared
// chunk, so each carries its own copy of TFMP_Runtime's module state, and only the
// `./ai-runtime` copy ever resolves a fileset. Exporting the setter here would hand
// callers a knob that silently does nothing — import it from
// `@workglow/tf-mediapipe/ai-runtime` instead.
export type { ITFMPWasmBaseUrls } from "./common/TFMP_Runtime";

import { inferTfmpCapabilities, TFMP_RUN_FN_SPECS } from "./common/TFMP_Capabilities";
import { toTexImageSource } from "./common/TFMP_Image";
import { buildGenaiPrompt, resolveTfmpChatTemplate } from "./common/TFMP_ChatTemplate";
import { resolveTfmpDelegate } from "./common/TFMP_Delegate";
import { isGenaiBusy, withGenaiLock } from "./common/TFMP_GenaiRuntime";
import { TFMP_PREVIEW_TASKS, TFMP_RUN_FNS } from "./common/TFMP_JobRunFns";
import {
  normalizeTfmpModelId,
  resolveTfmpProfile,
  resolveTfmpRecordProfile,
  TFMP_MODEL_FAMILIES,
  tfmpProfileCapabilities,
} from "./common/TFMP_ModelProfiles";
import { optionsMatch } from "./common/TFMP_Runtime";
import { extractJsonFromText } from "./common/TFMP_StructuredGeneration";
import { TensorFlowMediaPipeQueuedProvider } from "./TensorFlowMediaPipeQueuedProvider";

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the stable public API.
 */
export const _testOnly = {
  TensorFlowMediaPipeQueuedProvider,
  TFMP_RUN_FN_SPECS,
  TFMP_RUN_FNS,
  TFMP_PREVIEW_TASKS,
  TFMP_MODEL_FAMILIES,
  normalizeTfmpModelId,
  resolveTfmpProfile,
  resolveTfmpRecordProfile,
  tfmpProfileCapabilities,
  inferTfmpCapabilities,
  toTexImageSource,
  buildGenaiPrompt,
  resolveTfmpChatTemplate,
  resolveTfmpDelegate,
  optionsMatch,
  extractJsonFromText,
  withGenaiLock,
  isGenaiBusy,
} as const;
