/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * State machine that filters `<tool_call>…</tool_call>` markup out of a
 * stream of text-delta tokens. Tokens that are clearly outside markup are
 * flushed immediately; tokens that *might* be the start of a tag are held
 * in a lookahead buffer until they can be disambiguated.
 *
 * A block the stream never closes is suppressed to the end: a generation cut
 * off at the token limit loses its closing tag, and what follows the opening
 * one is still payload.
 *
 * This only handles the XML-tag pattern. Bare-JSON tool calls cannot be
 * reliably detected token-by-token, so a provider whose model emits them
 * handles those itself.
 */
export function createToolCallMarkupFilter(emit: (text: string) => void): {
  feed: (token: string) => void;
  flush: () => void;
} {
  const OPEN_TAG = "<tool_call>";
  const CLOSE_TAG = "</tool_call>";

  /** "text" = normal output, "tag" = inside a tool_call block */
  let state: "text" | "tag" = "text";
  /** Buffered text that might be a partial tag prefix */
  let pending = "";

  function feed(token: string) {
    if (state === "tag") {
      // Inside a tool_call block — suppress everything until we see the close tag
      pending += token;
      const closeIdx = pending.indexOf(CLOSE_TAG);
      if (closeIdx !== -1) {
        // End of the tool_call block; resume normal output after the close tag
        const afterClose = pending.slice(closeIdx + CLOSE_TAG.length);
        pending = "";
        state = "text";
        if (afterClose.length > 0) {
          feed(afterClose);
        }
      }
      // else: still inside the tag block, keep suppressing
      return;
    }

    // state === "text"
    const combined = pending + token;

    // Check for a complete open tag
    const openIdx = combined.indexOf(OPEN_TAG);
    if (openIdx !== -1) {
      // Emit everything before the tag
      const before = combined.slice(0, openIdx);
      if (before.length > 0) {
        emit(before);
      }
      // Switch to tag state; feed the remainder (after the open tag) back through
      pending = "";
      state = "tag";
      const afterOpen = combined.slice(openIdx + OPEN_TAG.length);
      if (afterOpen.length > 0) {
        feed(afterOpen);
      }
      return;
    }

    // Check if the tail of `combined` could be the start of "<tool_call>"
    // e.g. combined ends with "<", "<t", "<to", ..., "<tool_call"
    let prefixLen = 0;
    for (let len = Math.min(combined.length, OPEN_TAG.length - 1); len >= 1; len--) {
      if (combined.endsWith(OPEN_TAG.slice(0, len))) {
        prefixLen = len;
        break;
      }
    }

    if (prefixLen > 0) {
      // The tail is ambiguous — hold it back, flush the rest
      const safe = combined.slice(0, combined.length - prefixLen);
      if (safe.length > 0) {
        emit(safe);
      }
      pending = combined.slice(combined.length - prefixLen);
    } else {
      // No ambiguity — flush everything
      if (combined.length > 0) {
        emit(combined);
      }
      pending = "";
    }
  }

  /** Flush any remaining buffered text (called when the stream ends). */
  function flush() {
    if (pending.length > 0 && state === "text") {
      emit(pending);
      pending = "";
    }
    // If state === "tag", the pending content is suppressed tool-call markup
    pending = "";
    state = "text";
  }

  return { feed, flush };
}
