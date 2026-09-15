/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import type { A2UIServerMessage } from "../../protocol/messages";
import { foldSurfaces } from "../../protocol/surfaces";
import { A2UI_BASIC_CATALOG, A2UI_BASIC_CATALOG_ID } from "../basicCatalog";
import { batchCatalogIssues, referencedComponentIds } from "../validateAgainstCatalog";

const catalog = A2UI_BASIC_CATALOG;

function batch(...components: Record<string, unknown>[]): A2UIServerMessage[] {
  return [
    { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: A2UI_BASIC_CATALOG_ID } },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: "s1",
        components: components as { id: string; component: string }[],
      },
    },
  ];
}

function codes(messages: A2UIServerMessage[]): string[] {
  return batchCatalogIssues(messages, { catalog }).map((issue) => issue.code);
}

describe("batchCatalogIssues", () => {
  it("accepts a well-formed surface", () => {
    const issues = batchCatalogIssues(
      batch(
        { id: "root", component: "Column", children: ["hello", "go"] },
        { id: "hello", component: "Text", text: "Hi", variant: "h2" },
        {
          id: "go",
          component: "Button",
          child: "label",
          action: { event: { name: "go", context: {} } },
        },
        { id: "label", component: "Text", text: "Go" }
      ),
      { catalog }
    );
    expect(issues).toEqual([]);
  });

  it("refuses a component the catalog does not define", () => {
    expect(codes(batch({ id: "root", component: "ScriptTag", src: "x" }))).toContain(
      "UNKNOWN_COMPONENT"
    );
  });

  it("refuses a property the component does not have", () => {
    expect(
      codes(batch({ id: "root", component: "Text", text: "x", onClick: "alert(1)" }))
    ).toContain("UNKNOWN_PROPERTY");
  });

  it("refuses a missing required property", () => {
    expect(codes(batch({ id: "root", component: "Text" }))).toContain("MISSING_PROPERTY");
  });

  it("refuses a value outside a closed set", () => {
    expect(codes(batch({ id: "root", component: "Text", text: "x", variant: "h9" }))).toContain(
      "BAD_VALUE"
    );
  });

  it("refuses a javascript: URL on a property the renderer fetches", () => {
    // The catalog types url as a string, so nothing in the protocol itself
    // stops an agent naming a scheme that executes in the surface's own page.
    expect(
      codes(batch({ id: "root", component: "Image", url: "javascript:alert(document.cookie)" }))
    ).toContain("BAD_URL");
  });

  it("refuses a data: URL, which smuggles markup past the component allowlist", () => {
    expect(
      codes(batch({ id: "root", component: "Video", url: "data:text/html;base64,PHNjcmlwdD4=" }))
    ).toContain("BAD_URL");
  });

  it("accepts a binding in a URL property, since the batch wrote the model it reads", () => {
    const issues = batchCatalogIssues(
      [
        { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: A2UI_BASIC_CATALOG_ID } },
        {
          version: "v0.9",
          updateDataModel: { surfaceId: "s1", path: "/", value: { src: "https://x/y.png" } },
        },
        {
          version: "v0.9",
          updateComponents: {
            surfaceId: "s1",
            components: [{ id: "root", component: "Image", url: { path: "/src" } }],
          },
        },
      ],
      { catalog }
    );
    expect(issues).toEqual([]);
  });

  it("refuses a call to a function the catalog does not declare", () => {
    // Left unchecked it resolves to undefined and draws an empty label, which
    // reads as missing data rather than as a surface asking for something no
    // host implements.
    expect(
      codes(
        batch({
          id: "root",
          component: "Text",
          text: { call: "exfiltrate", args: { value: { path: "/secret" } } },
        })
      )
    ).toContain("UNKNOWN_FUNCTION");
  });

  it("finds a call nested inside an action context, not just at the top level", () => {
    expect(
      codes(
        batch(
          { id: "root", component: "Column", children: ["go"] },
          {
            id: "go",
            component: "Button",
            child: "label",
            action: { event: { name: "go", context: { x: { call: "nope", args: {} } } } },
          },
          { id: "label", component: "Text", text: "Go" }
        )
      )
    ).toContain("UNKNOWN_FUNCTION");
  });

  it("accepts a call the catalog declares", () => {
    const issues = batchCatalogIssues(
      batch({
        id: "root",
        component: "Text",
        text: { call: "formatCurrency", args: { value: 12.5, currency: "USD" } },
      }),
      { catalog }
    );
    expect(issues).toEqual([]);
  });

  it("refuses a surface with no root", () => {
    expect(codes(batch({ id: "body", component: "Text", text: "x" }))).toContain("MISSING_ROOT");
  });

  it("refuses a child id nothing defines", () => {
    expect(codes(batch({ id: "root", component: "Column", children: ["missing"] }))).toContain(
      "DANGLING_CHILD"
    );
  });

  it("refuses a catalog this host does not serve", () => {
    const issues = batchCatalogIssues(
      [{ version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "acme.com:private" } }],
      { catalog }
    );
    expect(issues.map((issue) => issue.code)).toEqual(["UNKNOWN_CATALOG"]);
  });

  it("checks nothing for a surface the batch went on to delete", () => {
    const issues = batchCatalogIssues(
      [
        { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: A2UI_BASIC_CATALOG_ID } },
        { version: "v0.9", deleteSurface: { surfaceId: "s1" } },
      ],
      { catalog }
    );
    expect(issues).toEqual([]);
  });
});

describe("referencedComponentIds", () => {
  it("reads a static child list", () => {
    const component = { id: "root", component: "Column", children: ["a", "b"] };
    expect(referencedComponentIds(component, catalog)).toEqual(["a", "b"]);
  });

  it("reads a repeat template's component id", () => {
    const component = {
      id: "root",
      component: "Column",
      children: { path: "/items", componentId: "row" },
    };
    expect(referencedComponentIds(component, catalog)).toEqual(["row"]);
  });

  it("reads the single-child spelling", () => {
    expect(referencedComponentIds({ id: "c", component: "Card", child: "body" }, catalog)).toEqual([
      "body",
    ]);
  });

  it("reads a Tabs page's child, which no `children` reader would find", () => {
    const component = {
      id: "t",
      component: "Tabs",
      tabs: [
        { title: "One", child: "page1" },
        { title: "Two", child: "page2" },
      ],
    };
    expect(referencedComponentIds(component, catalog)).toEqual(["page1", "page2"]);
  });

  it("reads both of Modal's component references", () => {
    const component = { id: "m", component: "Modal", trigger: "open", content: "body" };
    expect(referencedComponentIds(component, catalog)).toEqual(["open", "body"]);
  });
});

describe("the fold and the catalog check together", () => {
  it("accepts a container defined before the children it names", () => {
    // The protocol's incremental idiom. A per-message check would call this
    // broken; the check runs on the folded batch for exactly this reason.
    const messages: A2UIServerMessage[] = [
      { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: A2UI_BASIC_CATALOG_ID } },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "s1",
          components: [{ id: "root", component: "Card", child: "body" }],
        },
      },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "s1",
          components: [{ id: "body", component: "Text", text: "later" }],
        },
      },
    ];
    expect(foldSurfaces(messages).get("s1")?.components.size).toBe(2);
    expect(batchCatalogIssues(messages, { catalog })).toEqual([]);
  });
});
