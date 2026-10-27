/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// ESC [ parameters intermediates final — the CSI sequences npm and node colour with.
// eslint-disable-next-line no-control-regex
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** Terminal escapes mean nothing to a model and cost tokens. */
export function stripAnsi(text: string): string {
  return text.replace(CSI, "").replaceAll("\r\n", "\n");
}
