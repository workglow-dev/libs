/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Heavyweight HuggingFace Transformers registration: worker server (`registerHuggingFaceTransformersWorker`)
 * and main-thread inline (`registerHuggingFaceTransformersInline`). Import from
 * `@workglow/huggingface-transformers/ai-runtime` only — not from the main `hf-transformers` barrel.
 *
 * Use `export *` (not `export { … } from "…"`) so the Bun bundler keeps the module graph.
 */

// organize-imports-ignore

export * from "./common/HFT_BackgroundRemoval";
export * from "./common/HFT_Constants";
export * from "./common/HFT_Device";
export * from "./common/HFT_ModelSchema";
export * from "./common/HFT_OnnxDtypes";
export * from "./common/HFT_Pipeline";
export * from "./common/HFT_Streaming";
export * from "./common/HFT_TextReranker";
export * from "./common/HFT_ToolMarkup";
export * from "./registerHuggingFaceTransformersInline";
export * from "./registerHuggingFaceTransformersWorker";

import { HFT_RUN_FNS } from "./common/HFT_JobRunFns";

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the stable public API.
 */
export const _testOnly = {
  HFT_RUN_FNS,
} as const;
