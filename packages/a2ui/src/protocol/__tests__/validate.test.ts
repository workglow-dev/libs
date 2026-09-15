/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_A2UI_VALIDATION_LIMITS,
  validateClientMessage,
  validateServerMessage,
  validateServerMessages,
} from "../validate";

const create = {
  version: "v0.9",
  createSurface: { surfaceId: "s1", catalogId: "cat" },
};

function reasonOf(result: { ok: boolean; reason?: string }): string {
  return result.ok ? "" : (result.reason ?? "");
}

describe("validateServerMessage", () => {
  it("accepts each of the four kinds", () => {
    expect(validateServerMessage(create).ok).toBe(true);
    expect(
      validateServerMessage({
        version: "v0.9",
        updateComponents: { surfaceId: "s1", components: [{ id: "root", component: "Text" }] },
      }).ok
    ).toBe(true);
    expect(
      validateServerMessage({ version: "v0.9", updateDataModel: { surfaceId: "s1" } }).ok
    ).toBe(true);
    expect(validateServerMessage({ version: "v0.9", deleteSurface: { surfaceId: "s1" } }).ok).toBe(
      true
    );
  });

  it("refuses another protocol version rather than reading it under these rules", () => {
    expect(reasonOf(validateServerMessage({ ...create, version: "v1.0" }))).toMatch(/version/);
  });

  it("refuses a message carrying two kinds at once", () => {
    const result = validateServerMessage({
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: "cat" },
      deleteSurface: { surfaceId: "s1" },
    });
    expect(reasonOf(result)).toMatch(/it may carry one/);
  });

  it("refuses unknown keys on the message and on its body", () => {
    expect(reasonOf(validateServerMessage({ ...create, extra: 1 }))).toMatch(/unknown keys/);
    expect(
      reasonOf(
        validateServerMessage({
          version: "v0.9",
          createSurface: { surfaceId: "s1", catalogId: "cat", onLoad: "x" },
        })
      )
    ).toMatch(/unknown keys/);
  });

  it("refuses a component list that defines one id twice", () => {
    const result = validateServerMessage({
      version: "v0.9",
      updateComponents: {
        surfaceId: "s1",
        components: [
          { id: "root", component: "Column" },
          { id: "root", component: "Text" },
        ],
      },
    });
    expect(reasonOf(result)).toMatch(/twice/);
  });

  it("refuses a data model pointer that reaches the prototype", () => {
    const result = validateServerMessage({
      version: "v0.9",
      updateDataModel: { surfaceId: "s1", path: "/__proto__/x", value: 1 },
    });
    expect(reasonOf(result)).toMatch(/not a writable key/);
  });

  it("bounds how deep one property may nest", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < DEFAULT_A2UI_VALIDATION_LIMITS.maxValueDepth + 2; i++) deep = { deep };
    const result = validateServerMessage({
      version: "v0.9",
      updateComponents: {
        surfaceId: "s1",
        components: [{ id: "root", component: "Text", text: deep }],
      },
    });
    expect(reasonOf(result)).toMatch(/nests deeper/);
  });
});

describe("validateServerMessages", () => {
  it("accepts a batch and unwraps the object form", () => {
    const messages = [create];
    expect(validateServerMessages(messages).ok).toBe(true);
    expect(validateServerMessages({ messages }).ok).toBe(true);
  });

  it("refuses an update naming a surface the batch never created", () => {
    const result = validateServerMessages([
      {
        version: "v0.9",
        updateComponents: { surfaceId: "ghost", components: [{ id: "root", component: "Text" }] },
      },
    ]);
    expect(reasonOf(result)).toMatch(/never created/);
  });

  it("refuses creating one surface twice", () => {
    expect(reasonOf(validateServerMessages([create, create]))).toMatch(/already exists/);
  });

  it("lets a surface be recreated after it was deleted", () => {
    const result = validateServerMessages([
      create,
      { version: "v0.9", deleteSurface: { surfaceId: "s1" } },
      create,
    ]);
    expect(result.ok).toBe(true);
  });

  it("bounds components across a whole surface, not just one message", () => {
    const half = Math.ceil(DEFAULT_A2UI_VALIDATION_LIMITS.maxComponents / 2) + 1;
    const components = (prefix: string) =>
      Array.from({ length: half }, (_, i) => ({
        id: `${prefix}${i}`,
        component: "Text",
        text: "x",
      }));
    const result = validateServerMessages([
      create,
      { version: "v0.9", updateComponents: { surfaceId: "s1", components: components("a") } },
      { version: "v0.9", updateComponents: { surfaceId: "s1", components: components("b") } },
    ]);
    expect(reasonOf(result)).toMatch(/more than/);
  });

  it("names the message index so an agent can find what it got wrong", () => {
    const result = validateServerMessages([create, { version: "v0.9" }]);
    expect(reasonOf(result)).toMatch(/^message 1:/);
  });
});

describe("validateClientMessage", () => {
  it("accepts an action with every field the schema requires", () => {
    const result = validateClientMessage({
      version: "v0.9",
      action: {
        name: "book_now",
        surfaceId: "s1",
        sourceComponentId: "btn",
        timestamp: "2026-09-15T00:00:00.000Z",
        context: { restaurant: "The Golden Fork" },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a message carrying both an action and an error", () => {
    const result = validateClientMessage({
      version: "v0.9",
      action: { name: "a", surfaceId: "s", sourceComponentId: "c", timestamp: "t", context: {} },
      error: { code: "X", surfaceId: "s", message: "m" },
    });
    expect(reasonOf(result)).toMatch(/exactly one/);
  });

  it("refuses an action whose context is not an object", () => {
    const result = validateClientMessage({
      version: "v0.9",
      action: {
        name: "a",
        surfaceId: "s",
        sourceComponentId: "c",
        timestamp: "t",
        context: "nope",
      },
    });
    expect(reasonOf(result)).toMatch(/context must be an object/);
  });
});
