/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DataPortSchema } from "@workglow/util/schema";
import type { A2UICatalogSpec } from "./CatalogSpec";

/**
 * The name every host offers this under.
 *
 * Shared rather than chosen per host because a model that learned the tool in
 * one place should find it in the next, and because a conversation's transcript
 * outlives the host that produced it — a saved turn naming `render_ui` has to
 * mean the same thing when it is replayed somewhere else.
 */
export const A2UI_RENDER_TOOL_NAME = "render_ui";

export const A2UI_RENDER_TOOL_DESCRIPTION =
  "Draws a real interface for the user — cards, forms, pickers, buttons — as A2UI messages, " +
  "and returns what they did with it. Prefer this over describing a UI in prose when the user " +
  "has something to choose, fill in or confirm.";

/**
 * The tool's arguments, as a model must write them.
 *
 * `messages` is typed loosely on purpose: the protocol's four message shapes are
 * a `oneOf` whose bodies share no properties, and providers differ in how much
 * of a nested `oneOf` they honour when constraining a model's output. The shape
 * is taught in the prompt (see {@link describeA2UICatalog}) and enforced after
 * the call by `validateServerMessages`, which can say what was wrong in a
 * sentence the model can act on — where a schema rejection reaches it, when it
 * reaches it at all, as a provider's own error.
 */
export function a2uiRenderToolInputSchema(catalog: A2UICatalogSpec): DataPortSchema {
  return {
    type: "object",
    properties: {
      messages: {
        type: "array",
        title: "Messages",
        description:
          `A2UI v0.9 messages. Start with createSurface using catalogId "${catalog.catalogId}", ` +
          "then updateDataModel and updateComponents for the same surfaceId. One component must " +
          'have id "root".',
        items: { type: "object", additionalProperties: true },
      },
      expectsAction: {
        type: "boolean",
        title: "Expects Action",
        description:
          "True when you are waiting on the user to press or fill something in, false for a " +
          "surface that only reports. Defaults to true.",
      },
    },
    required: ["messages"],
    additionalProperties: false,
  };
}
