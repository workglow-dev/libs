/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { useInput } from "ink";

/**
 * Ink puts stdin in raw mode, so Ctrl-C is a keypress rather than SIGINT.
 * Re-emit it so the run's process-signal abort sees the same signal a web
 * console Abort (or `kill -INT`) sends.
 */
export function ForwardCtrlCAsSigint(): null {
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      process.emit("SIGINT");
    }
  });
  return null;
}
