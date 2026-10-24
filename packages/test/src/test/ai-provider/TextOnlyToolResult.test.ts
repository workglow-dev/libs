/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { omittedToolImageNote, textOnlyToolResult } from "@workglow/ai/provider-utils";
import { describe, expect, it } from "vitest";

describe("textOnlyToolResult", () => {
  it("names an image in the place it held, never its data", () => {
    const text = textOnlyToolResult([
      { type: "text", text: "before" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "text", text: "after" },
    ]);
    expect(text).toBe(`before\n${omittedToolImageNote("image/png")}\nafter`);
    expect(text).not.toContain("AAAA");
  });

  it("says an image-only result returned something", () => {
    expect(textOnlyToolResult([{ type: "image", mimeType: "image/jpeg", data: "AAAA" }])).toBe(
      "[image/jpeg image returned; this model reads text only]"
    );
  });

  it("keeps a nested block as JSON and skips empty text", () => {
    expect(
      textOnlyToolResult([
        { type: "text", text: "" },
        { type: "tool_use", id: "t1", name: "inner", input: { a: 1 } },
      ])
    ).toBe(JSON.stringify({ type: "tool_use", id: "t1", name: "inner", input: { a: 1 } }));
  });

  it("is empty for a result with no content", () => {
    expect(textOnlyToolResult([])).toBe("");
  });
});
