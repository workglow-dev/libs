/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// The classifier moved to @workglow/task-graph so packages that cannot depend on
// @workglow/tasks (browser-control) classify urls with the same rules. Re-exported
// here so existing importers are unchanged.
export {
  classifyIpLiteral,
  classifyUrl,
  tryNormalizeIPv4,
  urlMatchesScope,
  urlResourcePattern,
} from "@workglow/task-graph";
export type { UrlClassification, UrlClassificationKind } from "@workglow/task-graph";
