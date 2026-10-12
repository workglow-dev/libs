/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/** One routed piece of a stream: which output port it belongs to, and its text. */
export interface ThinkTagPart {
  readonly port: "text" | "reasoning";
  readonly text: string;
}

export interface ThinkTagFilter {
  /** Routes one streamed delta; returns the parts to emit, in order. */
  push(delta: string): ReadonlyArray<ThinkTagPart>;
  /** Releases anything held back and returns to the starting state. */
  flush(): ReadonlyArray<ThinkTagPart>;
}

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/** Length of the longest suffix of `text` that is a proper prefix of `tag`. */
function danglingPrefixLength(text: string, tag: string): number {
  for (let len = Math.min(text.length, tag.length - 1); len >= 1; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

/**
 * Splits a stream of text deltas into reasoning and answer text, using the
 * `<think>…</think>` convention of Qwen3-style chat templates.
 *
 * A tag can arrive split across deltas, so a suffix that might still become
 * the tag being looked for is held back until it resolves. A block the stream
 * never closes stays on `reasoning` to the end: a generation cut off at the
 * token limit loses its closing tag, and what follows the opening one is still
 * thinking.
 *
 * `startInside` is for a template that opens the tag in the prompt, so the
 * generation begins mid-block and only the closing tag appears in the stream.
 */
export function createThinkTagFilter(options?: {
  readonly startInside?: boolean | undefined;
}): ThinkTagFilter {
  const startInside = options?.startInside === true;
  let inside = startInside;
  let held = "";

  function part(port: "text" | "reasoning", text: string, into: ThinkTagPart[]): void {
    if (text.length > 0) into.push({ port, text });
  }

  function push(delta: string): ReadonlyArray<ThinkTagPart> {
    const out: ThinkTagPart[] = [];
    let buffer = held + delta;
    held = "";
    for (;;) {
      const tag = inside ? CLOSE_TAG : OPEN_TAG;
      const port = inside ? "reasoning" : "text";
      const at = buffer.indexOf(tag);
      if (at === -1) {
        const keep = danglingPrefixLength(buffer, tag);
        part(port, buffer.slice(0, buffer.length - keep), out);
        held = buffer.slice(buffer.length - keep);
        return out;
      }
      part(port, buffer.slice(0, at), out);
      buffer = buffer.slice(at + tag.length);
      inside = !inside;
    }
  }

  function flush(): ReadonlyArray<ThinkTagPart> {
    const out: ThinkTagPart[] = [];
    part(inside ? "reasoning" : "text", held, out);
    held = "";
    inside = startInside;
    return out;
  }

  return { push, flush };
}
