/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// The filter lives in `@workglow/ai/provider-utils`, where providers that
// cannot depend on this package share it; `./ai` and `./ai-runtime` keep
// serving it under the same name through this re-export.
export { createToolCallMarkupFilter } from "@workglow/ai/provider-utils";
