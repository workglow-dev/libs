/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a streaming task has said so far, split by the port it said it on.
 *
 * A task streams its answer on port `text` and a reasoning model's thinking on
 * port `reasoning`. Folded into one string the thinking reads as part of the
 * answer, so every surface that draws a streaming row folds through here and
 * decides for itself how to show the two apart.
 */
export interface StreamedText {
  readonly text: string;
  readonly reasoning: string;
}

export const EMPTY_STREAMED_TEXT: StreamedText = { text: "", reasoning: "" };

/** The part of a stream event the fold reads; any `StreamEvent` is assignable. */
export interface TextDeltaLike {
  readonly type: string;
  readonly port?: string;
  readonly textDelta?: string;
}

/** Lines of a streaming panel shown at once; the oldest scroll off the top. */
export const STREAM_PANEL_MAX_LINES = 8;

/** A text delta on a port worth showing: which one, and what it said. */
export interface ClassifiedDelta {
  readonly port: "text" | "reasoning";
  readonly delta: string;
}

/**
 * Reads a stream event as a text delta, or `undefined` when it is not one worth
 * showing. Port `reasoning` is the model's thinking; every other port, a missing
 * one included, is what the task is saying, since a task may stream its output
 * on a port of its own name (`code`, `summary`). An empty delta is ignored.
 */
export function classifyTextDelta(event: TextDeltaLike): ClassifiedDelta | undefined {
  if (event.type !== "text-delta") return undefined;
  const delta = event.textDelta ?? "";
  if (!delta) return undefined;
  return { port: event.port === "reasoning" ? "reasoning" : "text", delta };
}

/**
 * Folds one stream event into the accumulated text. Returns `prev` itself when
 * nothing changed so a state setter can bail out of a re-render.
 */
export function foldTextDelta(prev: StreamedText, event: TextDeltaLike): StreamedText {
  const classified = classifyTextDelta(event);
  if (!classified) return prev;
  return classified.port === "text"
    ? { text: prev.text + classified.delta, reasoning: prev.reasoning }
    : { text: prev.text, reasoning: prev.reasoning + classified.delta };
}

/** The last `n` lines of `text`, so a long stream never grows its panel. */
export function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return lines.slice(lines.length - n).join("\n");
}

/**
 * The thinking worth drawing, or "" when there is none. Reasoning is shown only
 * until the answer starts: once text is flowing it is the thing being read, and
 * the thinking behind it is no longer news.
 */
export function visibleReasoning(streamed: StreamedText): string {
  return streamed.text.length > 0 ? "" : streamed.reasoning;
}
