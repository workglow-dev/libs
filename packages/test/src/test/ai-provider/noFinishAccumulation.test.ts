/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StreamEvent } from "@workglow/task-graph";
import { expectNoFinishAccumulation } from "@workglow/test-contract/ai-provider";
import { describe, expect, it } from "vitest";

/**
 * The guard is itself a published assertion, so it needs to be shown failing as
 * well as passing — a conformance check nobody has watched go red is the shape
 * of defect it exists to catch.
 */
const events = (...list: ReadonlyArray<unknown>): StreamEvent<never>[] =>
  list as StreamEvent<never>[];

const textDelta = (textDelta: string) => ({ type: "text-delta", port: "text", textDelta });
const objectDelta = (port: string, objectDelta: unknown) => ({
  type: "object-delta",
  port,
  objectDelta,
});
const finish = (data: unknown) => ({ type: "finish", data });

describe("expectNoFinishAccumulation", () => {
  it("passes when finish carries the empty shape the output type requires", () => {
    expect(() =>
      expectNoFinishAccumulation(
        events(textDelta("Paris is "), textDelta("sunny."), finish({ text: "", toolCalls: [] }))
      )
    ).not.toThrow();
  });

  it("fails when finish repeats the accumulated text", () => {
    expect(() =>
      expectNoFinishAccumulation(
        events(
          textDelta("Paris is "),
          textDelta("sunny."),
          finish({ text: "Paris is sunny.", toolCalls: [] })
        )
      )
    ).toThrow(/finish\.text repeats text the deltas already delivered/);
  });

  it("fails on a partial repeat, not only an exact one", () => {
    // The markup-filtered stream and the parser's cleaned text differ slightly
    // at several providers, so containment either way is the test.
    expect(() =>
      expectNoFinishAccumulation(
        events(textDelta("Paris is sunny."), finish({ text: "Paris is", toolCalls: [] }))
      )
    ).toThrow(/finish\.text/);
  });

  it("fails when finish repeats tool calls an object-delta already emitted", () => {
    expect(() =>
      expectNoFinishAccumulation(
        events(
          objectDelta("toolCalls", [{ id: "call_0", name: "lookup_weather", input: {} }]),
          finish({ text: "", toolCalls: [{ id: "call_0", name: "lookup_weather", input: {} }] })
        )
      )
    ).toThrow(/finish\.toolCalls carries 1 entry/);
  });

  it("permits a field named in allowFields", () => {
    // A structured-generation run-fn must put `object` on finish; naming it is
    // how an exemption stays a decision rather than a default.
    expect(() =>
      expectNoFinishAccumulation(
        events(textDelta('{"city":'), textDelta('"Paris"}'), finish({ object: { city: "Paris" } })),
        { allowFields: ["object"] }
      )
    ).not.toThrow();
  });

  it("says nothing about a stream that never finished", () => {
    expect(() => expectNoFinishAccumulation(events(textDelta("partial")))).not.toThrow();
  });
});
