/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { A2UI_VERSION } from "../protocol/messages";
import { A2UI_ROOT_COMPONENT_ID } from "../protocol/surfaces";
import type { A2UICatalogSpec, A2UIComponentSpec } from "./CatalogSpec";

function describeComponent(component: A2UIComponentSpec): string {
  const lines: string[] = [`- **${component.name}** — ${component.description}`];
  for (const property of component.properties) {
    const marks: string[] = [];
    if (property.required) marks.push("required");
    if (property.values) marks.push(property.values.join(" | "));
    const suffix = marks.length > 0 ? ` (${marks.join("; ")})` : "";
    lines.push(`  - \`${property.name}\`${suffix}: ${property.description}`);
  }
  return lines.join("\n");
}

/**
 * The catalog as an agent needs to read it, for a system prompt.
 *
 * Generated from the same table the validator enforces, so the two cannot drift
 * — and drift here is expensive in a way a stale docs page is not: an agent told
 * about a property the validator refuses spends its rounds authoring surfaces
 * that are rejected, and the user watches it fail at something the prompt told
 * it to do.
 *
 * Written as instructions rather than as a schema dump because that is what the
 * whole batch is: a model emits this as tool arguments, and the two mistakes it
 * makes without being told are omitting the `{@link A2UI_ROOT_COMPONENT_ID}`
 * component and inventing components the renderer has never heard of.
 */
export function describeA2UICatalog(catalog: A2UICatalogSpec): string {
  return [
    "## Drawing a UI",
    "",
    "You can draw real interface — cards, forms, pickers, buttons — instead of describing it",
    "in prose. A UI is a *surface*: a flat list of components addressed by id, plus a JSON",
    "data model the components read through. You send a batch of messages, each tagged",
    `\`"version": "${A2UI_VERSION}"\`, in this order:`,
    "",
    "1. `createSurface` — `{ surfaceId, catalogId }`. One per batch is normal.",
    `   Use \`catalogId: "${catalog.catalogId}"\`.`,
    "2. `updateDataModel` — `{ surfaceId, path, value }`. `path` is a JSON pointer;",
    '   `"/"` replaces the whole model. Send this before the components that read it.',
    "3. `updateComponents` — `{ surfaceId, components }`. Each component is",
    "   `{ id, component, ...properties }`.",
    "",
    `Exactly one component must have \`"id": "${A2UI_ROOT_COMPONENT_ID}"\`; it is what gets drawn.`,
    "Every id a component names as a child must be defined somewhere in the same batch.",
    "",
    'Any property value may be a literal, or `{ "path": "/pointer" }` to read the data model.',
    "A relative path inside a repeated template reads that item. To repeat one component over a",
    'list, give `children` as `{ "path": "/items", "componentId": "row_template" }`.',
    "",
    'A `Button`\'s `action` is `{ "event": { "name": "<your event name>", "context": { ... } }}`.',
    "When the user presses it you are told the name and the resolved context, so put in",
    "`context` whatever you will need to act on it.",
    "",
    `A property may also be computed: \`{ "call": "<name>", "args": { ... } }\`. Available:`,
    `\`${catalog.functions.join("`, `")}\`.`,
    "",
    `### Components (${catalog.title})`,
    "",
    catalog.components.map(describeComponent).join("\n"),
    "",
    "Only these components exist. A surface naming anything else is refused whole, and",
    "properties not listed above are refused the same way.",
  ].join("\n");
}
