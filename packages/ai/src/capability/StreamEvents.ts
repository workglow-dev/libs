/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Re-exports the canonical stream event types from `@workglow/task-graph` for
 * capability-aware consumers that do not want to take a direct dependency on the
 * task-graph package.
 */
export type {
  StreamError,
  StreamEvent,
  StreamFinish,
  StreamMode,
  StreamObjectDelta,
  StreamPhase,
  StreamSnapshot,
  StreamTextDelta,
  Usage,
  UsageCounterField,
  UsagePromptField,
} from "@workglow/task-graph";

/**
 * Usage helpers are re-exported as values so a provider package can normalize
 * its own token counts (`import type { Usage } from "@workglow/ai"`) without
 * depending on `@workglow/task-graph` directly.
 */
export {
  mergeUsage,
  USAGE_COUNTER_FIELDS,
  USAGE_OUTPUT_KEY,
  USAGE_PROMPT_FIELDS,
} from "@workglow/task-graph";
