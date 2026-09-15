/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StreamEvent } from "@workglow/task-graph";

/**
 * Events a peer must not be shown.
 *
 * A2A peers are opaque to each other: a caller sees messages, task status and
 * artifacts, and not the callee's tools, model or rounds. `tool-call` says
 * which tool is running and `snapshot` carries the whole transcript, so both
 * describe the inside of an agent rather than its answer.
 *
 * This is a projection and not a property of the event, because the same two
 * events are exactly what an editor-facing surface wants: one protocol's
 * disclosure is another's feature.
 */
export function isOpaqueToPeer(event: StreamEvent): boolean {
  return event.type === "tool-call" || event.type === "snapshot";
}
