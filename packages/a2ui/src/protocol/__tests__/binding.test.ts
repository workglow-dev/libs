/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import type { A2UIResolveContext } from "../binding";
import {
  expandChildren,
  readPointer,
  resolveActionContext,
  resolvePath,
  resolveProps,
  resolveValue,
  writeTargetOf,
} from "../binding";

const MODEL = {
  title: "Top level",
  user: { name: "Ada", tags: ["a", "b"] },
  rows: [
    { title: "one", n: 1 },
    { title: "two", n: 2 },
  ],
};

function ctx(overrides: Partial<A2UIResolveContext> = {}): A2UIResolveContext {
  return { dataModel: MODEL, basePath: "", ...overrides };
}

describe("resolvePath", () => {
  it("takes an absolute path as-is, whatever the base", () => {
    expect(resolvePath("/user/name", "/rows/1")).toBe("/user/name");
  });

  it("resolves a relative path against the item being drawn", () => {
    expect(resolvePath("title", "/rows/1")).toBe("/rows/1/title");
  });

  it("reads a relative path at the root as a top-level key", () => {
    expect(resolvePath("title", "")).toBe("/title");
  });
});

describe("readPointer", () => {
  it("walks objects and arrays", () => {
    expect(readPointer(MODEL, "/rows/1/title")).toBe("two");
    expect(readPointer(MODEL, "/user/tags/0")).toBe("a");
  });

  it("answers undefined for a path nothing has written yet", () => {
    // The protocol's incremental idiom names a path before the message that
    // fills it, so this is a normal intermediate state, not an error.
    expect(readPointer(MODEL, "/not/here")).toBeUndefined();
  });

  it("answers the whole model at the root", () => {
    expect(readPointer(MODEL, "/")).toBe(MODEL);
  });
});

describe("resolveValue", () => {
  it("passes a literal through", () => {
    expect(resolveValue("plain", ctx())).toBe("plain");
    expect(resolveValue(7, ctx())).toBe(7);
  });

  it("reads a binding", () => {
    expect(resolveValue({ path: "/title" }, ctx())).toBe("Top level");
  });

  it("reads a relative binding through the base path", () => {
    expect(resolveValue({ path: "title" }, ctx({ basePath: "/rows/0" }))).toBe("one");
    expect(resolveValue({ path: "title" }, ctx({ basePath: "/rows/1" }))).toBe("two");
  });

  it("resolves bindings nested inside objects and arrays", () => {
    const options = [{ label: { path: "/user/name" }, value: "a" }];
    expect(resolveValue(options, ctx())).toEqual([{ label: "Ada", value: "a" }]);
  });

  it("calls a registered function, resolving its arguments first", () => {
    const functions = {
      upper: (args: Record<string, unknown>) => String(args.value).toUpperCase(),
    };
    const value = { call: "upper", args: { value: { path: "/user/name" } } };
    expect(resolveValue(value, ctx({ functions }))).toBe("ADA");
  });

  it("resolves an unregistered function to nothing rather than throwing", () => {
    // The catalog check refuses such a surface before it is drawn; reaching
    // here is a host registering fewer functions than its catalog declares.
    expect(resolveValue({ call: "nope", args: {} }, ctx())).toBeUndefined();
  });
});

describe("resolveProps", () => {
  it("resolves every property except the ones addressing other components", () => {
    const component = {
      id: "row",
      component: "Column",
      children: ["a", "b"],
      title: { path: "title" },
      align: "start",
    };
    const props = resolveProps(component, ctx({ basePath: "/rows/1" }), ["children"]);
    expect(props).toEqual({ title: "two", align: "start" });
  });

  it("leaves a children template alone, rather than collapsing it to data", () => {
    const component = {
      id: "root",
      component: "Column",
      children: { path: "/rows", componentId: "row" },
    };
    expect(resolveProps(component, ctx(), ["children"])).toEqual({});
  });
});

describe("expandChildren", () => {
  it("expands a static list, keeping the parent's base path", () => {
    expect(expandChildren(["a", "b"], ctx({ basePath: "/rows/0" }))).toEqual([
      { componentId: "a", basePath: "/rows/0", key: "a:0" },
      { componentId: "b", basePath: "/rows/0", key: "b:1" },
    ]);
  });

  it("repeats a template once per item, each reading its own item", () => {
    const slots = expandChildren({ path: "/rows", componentId: "row" }, ctx());
    expect(slots).toHaveLength(2);
    expect(slots[0]?.basePath).toBe("/rows/0");
    expect(slots[1]?.basePath).toBe("/rows/1");
    // Without distinct base paths every row would draw the first row's data.
    expect(slots[0]?.key).not.toBe(slots[1]?.key);
  });

  it("resolves a template's relative path against the parent's base", () => {
    const model = { groups: [{ items: [{ n: 1 }, { n: 2 }, { n: 3 }] }] };
    const slots = expandChildren(
      { path: "items", componentId: "item" },
      ctx({ dataModel: model, basePath: "/groups/0" })
    );
    expect(slots.map((slot) => slot.basePath)).toEqual([
      "/groups/0/items/0",
      "/groups/0/items/1",
      "/groups/0/items/2",
    ]);
  });

  it("draws nothing for a template over a path holding no array yet", () => {
    expect(expandChildren({ path: "/pending", componentId: "row" }, ctx())).toEqual([]);
  });
});

describe("writeTargetOf", () => {
  it("names where a bound control writes", () => {
    expect(writeTargetOf({ path: "n" }, ctx({ basePath: "/rows/1" }))).toBe("/rows/1/n");
  });

  it("answers undefined for a control the agent wired to nothing", () => {
    expect(writeTargetOf("a literal", ctx())).toBeUndefined();
  });
});

describe("resolveActionContext", () => {
  it("reports the values as the person saw them, not the paths", () => {
    const resolved = resolveActionContext(
      { row: { path: "title" }, fixed: "literal" },
      ctx({ basePath: "/rows/1" })
    );
    expect(resolved).toEqual({ row: "two", fixed: "literal" });
  });

  it("answers an empty object for a context that is not one", () => {
    expect(resolveActionContext("nope", ctx())).toEqual({});
  });
});
