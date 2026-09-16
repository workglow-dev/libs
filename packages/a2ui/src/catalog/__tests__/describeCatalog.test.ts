/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { A2UI_BASIC_CATALOG } from "../basicCatalog";
import { describeA2UICatalog } from "../describeCatalog";

describe("describeA2UICatalog", () => {
  const text = describeA2UICatalog(A2UI_BASIC_CATALOG);

  it("names every component the validator will accept", () => {
    for (const component of A2UI_BASIC_CATALOG.components) {
      expect(text).toContain(`**${component.name}**`);
    }
  });

  it("names every property the validator will accept", () => {
    // Drift here is not a stale docs page: an agent told about a property the
    // validator refuses spends its rounds authoring surfaces that get rejected.
    for (const component of A2UI_BASIC_CATALOG.components) {
      for (const property of component.properties) {
        expect(text).toContain(`\`${property.name}\``);
      }
    }
  });

  it("states what an omitted property means", () => {
    // A default is part of the agreement rather than a renderer's private
    // choice: a Column whose align is absent stretches its children.
    expect(text).toContain('default "stretch"');
    expect(text).toContain("default false");
  });

  it("gives the catalog id an agent has to send", () => {
    expect(text).toContain(A2UI_BASIC_CATALOG.catalogId);
  });

  it("states the two rules a batch is most often refused for", () => {
    expect(text).toMatch(/"root"/);
    expect(text).toMatch(/child must be defined/);
  });
});
