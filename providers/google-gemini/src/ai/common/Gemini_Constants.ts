/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

export const GOOGLE_GEMINI = "GOOGLE_GEMINI";

/**
 * The Gemini Developer API version every client here is pinned to. `@google/genai`
 * 3.x defaults to `v1`, which answers 400 ("Use api version v1beta instead") to
 * `thinkingConfig` and the `googleSearch` tool on the 2.5 models. The model list is
 * pinned the same way: `v1beta` lists a superset of `v1`, previews included.
 */
export const GEMINI_API_VERSION = "v1beta";
