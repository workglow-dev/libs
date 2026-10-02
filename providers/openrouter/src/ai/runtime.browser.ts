/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

// There is no platform-specific runtime source here: the browser bundle is the
// same graph compiled `--target=browser`. Re-exporting the node barrel is what
// stops the two declarations drifting apart. Safe because the specifier is
// RELATIVE — resolved once, identically under either condition, so a
// hand-maintained copy of this file could only ever drift from the module it
// already resolves to.
export * from "./runtime";
