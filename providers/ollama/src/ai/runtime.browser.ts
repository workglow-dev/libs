/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Worker server and main-thread inline Ollama registration (browser build; pulls in `Ollama_JobRunFns.browser`),
 * plus SDK client helpers (`Ollama_Client.browser`).
 * Import from `@workglow/ollama/ai-runtime` — not from the main `ollama` barrel.
 *
 * Use `export *` (not `export { … } from "…"`) so the Bun bundler keeps the module graph.
 */
// organize-imports-ignore

export * from "./common/Ollama_Client.browser";
export * from "./common/Ollama_TextGeneration";
export * from "./common/Ollama_StructuredGeneration";
export * from "./registerOllamaInline.browser";
export * from "./registerOllamaWorker.browser";
