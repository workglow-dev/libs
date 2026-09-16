/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import type { A2UIServerMessage } from "../messages";
import { foldSurfaces } from "../surfaces";

const create: A2UIServerMessage = {
  version: "v0.9",
  createSurface: { surfaceId: "s1", catalogId: "cat" },
};

describe("foldSurfaces", () => {
  it("creates a surface with an empty tree and model", () => {
    const surface = foldSurfaces([create]).get("s1");
    expect(surface?.catalogId).toBe("cat");
    expect(surface?.components.size).toBe(0);
    expect(surface?.dataModel).toEqual({});
    expect(surface?.sendDataModel).toBe(false);
  });

  it("merges component updates and lets a later definition replace an earlier one", () => {
    const surfaces = foldSurfaces([
      create,
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "s1",
          components: [
            { id: "root", component: "Column", children: ["title"] },
            { id: "title", component: "Text", text: "first" },
          ],
        },
      },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "s1",
          components: [{ id: "title", component: "Text", text: "second" }],
        },
      },
    ]);
    const surface = surfaces.get("s1");
    expect(surface?.components.size).toBe(2);
    expect(surface?.components.get("title")?.text).toBe("second");
  });

  it("applies data model patches in order", () => {
    const surfaces = foldSurfaces([
      create,
      { version: "v0.9", updateDataModel: { surfaceId: "s1", path: "/", value: { items: [] } } },
      { version: "v0.9", updateDataModel: { surfaceId: "s1", path: "/items/0", value: "a" } },
    ]);
    expect(surfaces.get("s1")?.dataModel).toEqual({ items: ["a"] });
  });

  it("retires a surface on delete", () => {
    const surfaces = foldSurfaces([
      create,
      { version: "v0.9", deleteSurface: { surfaceId: "s1" } },
    ]);
    expect(surfaces.has("s1")).toBe(false);
  });

  it("skips a message naming a surface it has never seen", () => {
    // Refusing that batch is validateServerMessages' job; folding it twice
    // would make every caller handle the same failure in two places.
    const surfaces = foldSurfaces([
      { version: "v0.9", updateDataModel: { surfaceId: "ghost", path: "/", value: { x: 1 } } },
    ]);
    expect(surfaces.size).toBe(0);
  });

  it("continues from surfaces a previous fold left behind", () => {
    const first = foldSurfaces([create]);
    const second = foldSurfaces(
      [
        {
          version: "v0.9",
          updateComponents: {
            surfaceId: "s1",
            components: [{ id: "root", component: "Text", text: "hi" }],
          },
        },
      ],
      first.values()
    );
    expect(second.get("s1")?.components.get("root")?.text).toBe("hi");
  });

  it("leaves the surfaces a previous fold returned untouched", () => {
    const first = foldSurfaces([create]);
    foldSurfaces(
      [
        {
          version: "v0.9",
          updateComponents: {
            surfaceId: "s1",
            components: [{ id: "root", component: "Text", text: "hi" }],
          },
        },
      ],
      first.values()
    );
    expect(first.get("s1")?.components.size).toBe(0);
  });
});
