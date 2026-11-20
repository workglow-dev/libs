/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser build for Meta runtime registration (uses `js-tiktoken` instead of WASM `tiktoken`).
 * Import from `@workglow/meta/ai-runtime` — not from the main `meta` barrel.
 *
 * Use `export *` (not `export { … } from "…"`) so the Bun bundler keeps the module graph.
 */
// organize-imports-ignore

export * from "./common/Meta_Client";
export * from "./common/Meta_EffortPolicy";
export * from "./registerMetaInline.browser";
export * from "./registerMetaWorker.browser";
