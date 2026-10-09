/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { createThinkTagFilter } from "@workglow/ai/provider-utils";
import { describe, expect, it } from "vitest";

type Part = { readonly port: "text" | "reasoning"; readonly text: string };

/** Merges adjacent same-port parts so assertions do not depend on chunking. */
function merged(parts: ReadonlyArray<Part>): Part[] {
  const out: Part[] = [];
  for (const part of parts) {
    if (part.text === "") continue;
    const last = out[out.length - 1];
    if (last && last.port === part.port) {
      out[out.length - 1] = { port: last.port, text: last.text + part.text };
    } else {
      out.push(part);
    }
  }
  return out;
}

describe("createThinkTagFilter", () => {
  it("routes a think block to reasoning and the rest to text, across split tags", () => {
    const f = createThinkTagFilter();
    const parts = [
      ...f.push("<thi"),
      ...f.push("nk>plan"),
      ...f.push(" more</th"),
      ...f.push("ink>\n\nAnswer"),
      ...f.flush(),
    ];
    expect(merged(parts)).toEqual([
      { port: "reasoning", text: "plan more" },
      { port: "text", text: "\n\nAnswer" },
    ]);
    expect(parts.filter((p) => p.port === "reasoning").map((p) => p.text)).toEqual([
      "plan",
      " more",
    ]);
  });

  it("starts inside a think block when asked", () => {
    const g = createThinkTagFilter({ startInside: true });
    expect(merged([...g.push("why</think>ok"), ...g.flush()])).toEqual([
      { port: "reasoning", text: "why" },
      { port: "text", text: "ok" },
    ]);
  });

  it("passes text containing other tags through untouched", () => {
    const h = createThinkTagFilter();
    expect(merged([...h.push("plain <b>text</b>"), ...h.flush()])).toEqual([
      { port: "text", text: "plain <b>text</b>" },
    ]);
  });

  it("releases a held partial open tag as text once it cannot be a tag", () => {
    const f = createThinkTagFilter();
    const parts = [...f.push("a <thi"), ...f.push("s is fine"), ...f.flush()];
    expect(merged(parts)).toEqual([{ port: "text", text: "a <this is fine" }]);
  });

  it("flushes a partial tag held at the end of the stream on the port it was on", () => {
    const outside = createThinkTagFilter();
    expect(merged([...outside.push("done <thi"), ...outside.flush()])).toEqual([
      { port: "text", text: "done <thi" },
    ]);
    const inside = createThinkTagFilter({ startInside: true });
    expect(merged([...inside.push("thinking </thi"), ...inside.flush()])).toEqual([
      { port: "reasoning", text: "thinking </thi" },
    ]);
  });

  it("keeps an unterminated think block on reasoning to the end", () => {
    const f = createThinkTagFilter();
    expect(merged([...f.push("<think>cut off"), ...f.push(" here"), ...f.flush()])).toEqual([
      { port: "reasoning", text: "cut off here" },
    ]);
  });

  it("handles several blocks and a whole stream in one push", () => {
    const f = createThinkTagFilter();
    expect(merged([...f.push("<think>a</think>b<think>c</think>d"), ...f.flush()])).toEqual([
      { port: "reasoning", text: "a" },
      { port: "text", text: "b" },
      { port: "reasoning", text: "c" },
      { port: "text", text: "d" },
    ]);
  });

  it("gives the same result however the stream is chunked", () => {
    const whole = "x<think>why\nbecause</think>\nanswer <think> again </think>end";
    const expected = merged(
      (() => {
        const f = createThinkTagFilter();
        return [...f.push(whole), ...f.flush()];
      })()
    );
    for (let size = 1; size <= 8; size++) {
      const f = createThinkTagFilter();
      const parts: Part[] = [];
      for (let i = 0; i < whole.length; i += size) parts.push(...f.push(whole.slice(i, i + size)));
      parts.push(...f.flush());
      expect(merged(parts)).toEqual(expected);
    }
  });

  it("is usable again after a flush", () => {
    const f = createThinkTagFilter();
    f.push("<think>a");
    f.flush();
    expect(merged([...f.push("b"), ...f.flush()])).toEqual([{ port: "text", text: "b" }]);
  });
});
