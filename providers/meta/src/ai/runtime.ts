/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Worker server and main-thread inline Meta registration (pulls in `Meta_JobRunFns`),
 * plus SDK client helpers (`Meta_Client`).
 * Import from `@workglow/meta/ai-runtime` — not from the main `meta` barrel.
 *
 * Use `export *` (not `export { … } from "…"`) so the Bun bundler keeps the module graph.
 */
// organize-imports-ignore

export * from "./common/Meta_Client";
export * from "./common/Meta_EffortPolicy";
export * from "./registerMetaInline";
export * from "./registerMetaWorker";
