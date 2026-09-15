/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";

import {
  PartBindingError,
  partsToPorts,
  portsToParts,
  textOfParts,
  textPart,
} from "../partBinding";

const text = (value: string): Part => ({
  content: { $case: "text", value },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain",
});
const data = (value: Record<string, unknown>): Part => ({
  content: { $case: "data", value },
  metadata: undefined,
  filename: "",
  mediaType: "application/json",
});

describe("partBinding", () => {
  it("binds one text part into the schema's single required port", () => {
    const schema = {
      type: "object" as const,
      properties: { prompt: { type: "string" as const } },
      required: ["prompt"],
    };
    expect(partsToPorts([text("hello")], schema)).toEqual({ prompt: "hello" });
  });

  it("takes a data part's keys as ports, and lets it win over the text fallback", () => {
    const schema = {
      type: "object" as const,
      properties: { prompt: { type: "string" as const }, topK: { type: "number" as const } },
      required: ["prompt"],
    };
    expect(partsToPorts([text("hello"), data({ topK: 3 })], schema)).toEqual({
      prompt: "hello",
      topK: 3,
    });
  });

  it("joins several text parts rather than dropping all but one", () => {
    expect(textOfParts([text("a"), text("b")])).toBe("ab");
  });

  it("refuses to guess when the schema names more than one required port", () => {
    const schema = {
      type: "object" as const,
      properties: { a: { type: "string" as const }, b: { type: "string" as const } },
      required: ["a", "b"],
    };
    // Guessing which one the text meant is how a caller's argument silently
    // lands on the wrong port. A data part is how a caller says which.
    expect(() => partsToPorts([text("hello")], schema)).toThrow(PartBindingError);
  });

  it("names the ports it could not bind, so the caller can fix the call", () => {
    const schema = {
      type: "object" as const,
      properties: { a: { type: "string" as const }, b: { type: "string" as const } },
      required: ["a", "b"],
    };
    try {
      partsToPorts([text("hello")], schema);
      expect.unreachable("should have thrown");
    } catch (error) {
      // This reaches a peer as a protocol error, so "cannot bind" alone is
      // not actionable — it has to say which ports were left unset.
      expect(error).toBeInstanceOf(PartBindingError);
      expect((error as PartBindingError).unboundPorts).toEqual(["a", "b"]);
    }
  });

  it("ignores a data part whose value is not an object", () => {
    // A bare string or array names no port, so there is nothing to spread —
    // and spreading an array would bind ports called "0" and "1".
    const arrayPart: Part = {
      content: { $case: "data", value: ["x"] },
      metadata: undefined,
      filename: "",
      mediaType: "application/json",
    };
    expect(partsToPorts([arrayPart], undefined)).toEqual({});
  });

  it("emits a part the SDK will accept, media type and all", () => {
    expect(portsToParts({ answer: "yes", score: 0.5 })).toEqual([
      {
        content: { $case: "data", value: { answer: "yes", score: 0.5 } },
        metadata: undefined,
        filename: "",
        mediaType: "application/json",
      },
    ]);
    expect(textPart("hi")).toEqual(text("hi"));
  });

  it("survives a part carrying no content at all", () => {
    const empty: Part = { content: undefined, metadata: undefined, filename: "", mediaType: "" };
    expect(textOfParts([empty])).toBe("");
    expect(partsToPorts([empty], undefined)).toEqual({});
  });
});
