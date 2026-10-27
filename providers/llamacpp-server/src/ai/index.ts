/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

export * from "./common/LlamaCppServer_Constants";
export * from "./common/LlamaCppServer_ModelSchema";
export * from "./common/LlamaCppServer_Capabilities";
export * from "./common/LlamaCppServer_CapabilitySets";
export * from "./registerLlamaCppServer";
export * from "./registerLlamaCppServerInline";
export * from "./registerLlamaCppServerWorker";

import {
  inferLlamaCppServerCapabilities,
  LLAMACPP_SERVER_RUN_FN_SPECS,
} from "./common/LlamaCppServer_Capabilities";
import { buildLlamaCppServerRunFns } from "./common/LlamaCppServer_JobRunFns";
import {
  LLAMACPP_SERVER_MODEL_FAMILIES,
  llamaCppServerProfileCapabilities,
  normalizeLlamaCppServerModelId,
  resolveLlamaCppServerProfile,
} from "./common/LlamaCppServer_ModelProfiles";
import { LlamaCppServerQueuedProvider } from "./LlamaCppServerQueuedProvider";

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the stable public API.
 */
export const _testOnly = {
  LlamaCppServerQueuedProvider,
  LLAMACPP_SERVER_RUN_FN_SPECS,
  buildLlamaCppServerRunFns,
  LLAMACPP_SERVER_MODEL_FAMILIES,
  normalizeLlamaCppServerModelId,
  resolveLlamaCppServerProfile,
  llamaCppServerProfileCapabilities,
  inferLlamaCppServerCapabilities,
} as const;
