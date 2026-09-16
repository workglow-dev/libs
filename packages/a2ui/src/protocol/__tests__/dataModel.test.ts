/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { A2UIPointerError, applyDataModelPatch, parsePointer } from "../dataModel";

describe("parsePointer", () => {
  it("reads the root as no segments", () => {
    expect(parsePointer("/")).toEqual([]);
    expect(parsePointer("")).toEqual([]);
  });

  it("unescapes ~1 and ~0", () => {
    expect(parsePointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
  });

  it("refuses a pointer that does not start with a slash", () => {
    expect(() => parsePointer("user/name")).toThrow(A2UIPointerError);
  });

  it("refuses a segment that would reach the prototype", () => {
    expect(() => parsePointer("/__proto__/polluted")).toThrow(/not a writable key/);
  });
});

describe("applyDataModelPatch", () => {
  it("replaces the whole model at the root", () => {
    const next = applyDataModelPatch({ old: 1 }, "/", { fresh: 2 }, true);
    expect(next).toEqual({ fresh: 2 });
  });

  it("clears the model when the root carries no value", () => {
    expect(applyDataModelPatch({ old: 1 }, "/", undefined, false)).toEqual({});
  });

  it("refuses a non-object root", () => {
    expect(() => applyDataModelPatch({}, "/", [1, 2], true)).toThrow(/must be an object/);
  });

  it("writes a nested path, creating the containers on the way", () => {
    const next = applyDataModelPatch({}, "/user/name", "Ada", true);
    expect(next).toEqual({ user: { name: "Ada" } });
  });

  it("creates an array when the next segment is an index", () => {
    // The protocol's own incremental idiom: an item is written before the list
    // it belongs to exists.
    const next = applyDataModelPatch({}, "/items/0", { title: "one" }, true);
    expect(Array.isArray(next.items)).toBe(true);
    expect(next).toEqual({ items: [{ title: "one" }] });
  });

  it("removes a key when no value is carried", () => {
    const next = applyDataModelPatch(
      { user: { name: "Ada", age: 36 } },
      "/user/age",
      undefined,
      false
    );
    expect(next).toEqual({ user: { name: "Ada" } });
  });

  it("splices an array entry out rather than leaving a hole", () => {
    const next = applyDataModelPatch({ items: ["a", "b", "c"] }, "/items/1", undefined, false);
    expect(next).toEqual({ items: ["a", "c"] });
  });

  it("leaves the model it was given untouched", () => {
    const before = { user: { name: "Ada" } };
    const next = applyDataModelPatch(before, "/user/name", "Grace", true);
    expect(before).toEqual({ user: { name: "Ada" } });
    expect(next).toEqual({ user: { name: "Grace" } });
  });

  it("strips a reserved key out of a written value rather than assigning it", () => {
    const next = applyDataModelPatch({}, "/", { safe: 1, ["__proto__"]: { polluted: true } }, true);
    expect(next).toEqual({ safe: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses a non-numeric segment into an array", () => {
    expect(() => applyDataModelPatch({ items: ["a"] }, "/items/first", "x", true)).toThrow(
      /not an array index/
    );
  });
});

describe("bounds a patch cannot exceed", () => {
  it("refuses an array index that would report a billion entries", () => {
    // An index is also a length: anything that then walks the array — a
    // repeated template most obviously — hangs the renderer over one message.
    expect(() => applyDataModelPatch({}, "/items/4294967294", "x", true)).toThrow(/beyond/);
  });

  it("still writes an ordinary index", () => {
    // Sparse, because the agent wrote index 2 and said nothing about 0 or 1.
    const next = applyDataModelPatch({}, "/items/2", "x", true);
    expect(next.items).toHaveLength(3);
    expect((next.items as unknown[])[2]).toBe("x");
  });

  it("does not build the path a delete walks", () => {
    // Creating `{ user: {} }` on the way to removing `/user/name` turns a
    // binding on `/user` from undefined into an object — a write nobody asked
    // for, and one a surface can see.
    expect(applyDataModelPatch({}, "/user/name", undefined, false)).toEqual({});
    expect(applyDataModelPatch({ a: 1 }, "/x/y/z", undefined, false)).toEqual({ a: 1 });
  });

  it("still deletes something that is there", () => {
    expect(
      applyDataModelPatch({ user: { name: "Ada", age: 36 } }, "/user/name", undefined, false)
    ).toEqual({ user: { age: 36 } });
  });
});
