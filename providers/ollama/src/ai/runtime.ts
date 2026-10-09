/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Worker server and main-thread inline Ollama registration (node build; pulls in `Ollama_JobRunFns`),
 * plus SDK client helpers (`Ollama_Client`).
 * Import from `@workglow/ollama/ai-runtime` — not from the main `ollama` barrel.
 *
 * Use `export *` (not `export { … } from "…"`) so the Bun bundler keeps the module graph.
 */
// organize-imports-ignore

export * from "./common/Ollama_Client";
export * from "./common/Ollama_EffortPolicy";
export * from "./common/Ollama_TextGeneration";
export * from "./common/Ollama_StructuredGeneration";
export * from "./registerOllamaInline";
export * from "./registerOllamaWorker";
