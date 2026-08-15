/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

// See `ai.browser.ts`: no platform-specific source here either, so the browser
// entry re-exports the node one rather than duplicating it. Relative specifier,
// resolved identically under both conditions.
export * from "./ai-runtime";
