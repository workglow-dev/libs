/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

// This package has no platform-specific source: the browser bundle is the same
// graph compiled `--target=browser`. Re-exporting the node entry is what stops
// the two declarations drifting apart. Safe because the specifier is RELATIVE —
// resolved once, identically under either condition. A future toolchain plugin
// that substituted `X.browser.ts` for `X.ts` on relative specifiers would make
// this a cycle.
export * from "./ai";
