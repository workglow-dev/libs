/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { A2UICatalogSpec } from "./CatalogSpec";

/**
 * The catalog id every conforming renderer answers to.
 *
 * It is a URL because the protocol says so, and it is never fetched: a catalog
 * id identifies an agreement between an agent and a renderer that both already
 * hold. A host resolving it over the network would be taking the component
 * allowlist from whoever answers that host.
 */
export const A2UI_BASIC_CATALOG_ID =
  "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";

/**
 * The A2UI basic catalog, as much of it as a host enforces.
 *
 * Transcribed from the published catalog rather than fetched or generated, for
 * the reason above: this table is the allowlist, so it has to be readable in
 * review. Keeping it honest is the job of whichever host installs a renderer,
 * which is the only place the shipped catalog is actually on disk to compare
 * against — this package deliberately depends on no renderer.
 */
export const A2UI_BASIC_CATALOG: A2UICatalogSpec = {
  catalogId: A2UI_BASIC_CATALOG_ID,
  title: "A2UI Basic Catalog",
  functions: [
    "required",
    "regex",
    "length",
    "numeric",
    "email",
    "formatString",
    "formatNumber",
    "formatCurrency",
    "formatDate",
    "pluralize",
    "openUrl",
    "and",
    "or",
    "not",
  ],
  components: [
    {
      name: "Text",
      description: "A run of text. Simple Markdown is supported; HTML and links are not.",
      properties: [
        { name: "text", required: true, description: "The text to display" },
        {
          name: "variant",
          default: "body",
          required: false,
          description: "Base text style",
          values: ["h1", "h2", "h3", "h4", "h5", "caption", "body"],
        },
      ],
    },
    {
      name: "Image",
      description: "An image loaded from a URL.",
      properties: [
        { name: "url", required: true, description: "Image URL", url: true },
        { name: "description", required: false, description: "Accessibility text" },
        {
          name: "fit",
          default: "fill",
          required: false,
          description: "How the image is resized to its container",
          values: ["contain", "cover", "fill", "none", "scaleDown"],
        },
        {
          name: "variant",
          default: "mediumFeature",
          required: false,
          description: "Size and style hint",
          values: ["icon", "avatar", "smallFeature", "mediumFeature", "largeFeature", "header"],
        },
      ],
    },
    {
      name: "Icon",
      description: "A named icon from the renderer's own set.",
      properties: [{ name: "name", required: true, description: "Icon name" }],
    },
    {
      name: "Video",
      description: "A video loaded from a URL.",
      properties: [{ name: "url", required: true, description: "Video URL", url: true }],
    },
    {
      name: "AudioPlayer",
      description: "An audio track loaded from a URL.",
      properties: [
        { name: "url", required: true, description: "Audio URL", url: true },
        { name: "description", required: false, description: "Title or summary of the audio" },
      ],
    },
    {
      name: "Row",
      description: "Lays its children out horizontally.",
      properties: [
        {
          name: "children",
          required: true,
          description: "Child ids, or { path, componentId } to repeat one child over a data list",
          references: "children",
        },
        {
          name: "justify",
          default: "start",
          required: false,
          description: "Arrangement along the horizontal axis",
          values: [
            "start",
            "center",
            "end",
            "spaceAround",
            "spaceBetween",
            "spaceEvenly",
            "stretch",
          ],
        },
        {
          name: "align",
          default: "stretch",
          required: false,
          description: "Alignment along the vertical axis",
          values: ["start", "center", "end", "stretch"],
        },
      ],
    },
    {
      name: "Column",
      description: "Lays its children out vertically.",
      properties: [
        {
          name: "children",
          required: true,
          description: "Child ids, or { path, componentId } to repeat one child over a data list",
          references: "children",
        },
        {
          name: "justify",
          default: "start",
          required: false,
          description: "Arrangement along the vertical axis",
          values: [
            "start",
            "center",
            "end",
            "spaceAround",
            "spaceBetween",
            "spaceEvenly",
            "stretch",
          ],
        },
        {
          name: "align",
          default: "stretch",
          required: false,
          description: "Alignment along the horizontal axis",
          values: ["start", "center", "end", "stretch"],
        },
      ],
    },
    {
      name: "List",
      description: "A scrollable list of children.",
      properties: [
        {
          name: "children",
          required: true,
          description: "Child ids, or { path, componentId } to repeat one child over a data list",
          references: "children",
        },
        {
          name: "direction",
          default: "vertical",
          required: false,
          description: "Layout direction",
          values: ["vertical", "horizontal"],
        },
        {
          name: "align",
          default: "stretch",
          required: false,
          description: "Alignment along the cross axis",
          values: ["start", "center", "end", "stretch"],
        },
      ],
    },
    {
      name: "Card",
      description: "A surface with one child inside it. Wrap a Column to hold several.",
      properties: [
        { name: "child", required: true, description: "The child id", references: "id" },
      ],
    },
    {
      name: "Tabs",
      description: "Tabbed pages, one child per tab.",
      properties: [
        {
          name: "tabs",
          required: true,
          description: "Objects of { title, child }, one per tab",
          references: "item-child",
        },
      ],
    },
    {
      name: "Modal",
      description: "Content shown over the surface, opened by a trigger component.",
      properties: [
        {
          name: "trigger",
          required: true,
          description: "Id of the opening component",
          references: "id",
        },
        {
          name: "content",
          required: true,
          description: "Id of the content component",
          references: "id",
        },
      ],
    },
    {
      name: "Divider",
      description: "A rule between sections.",
      properties: [
        {
          name: "axis",
          default: "horizontal",
          required: false,
          description: "Orientation",
          values: ["horizontal", "vertical"],
        },
      ],
    },
    {
      name: "Button",
      description: "A pressable control that dispatches an action.",
      properties: [
        {
          name: "child",
          required: true,
          description: "Id of the label component, normally a Text",
          references: "id",
        },
        {
          name: "action",
          required: true,
          description: 'What pressing it does: { "event": { "name", "context" } }',
        },
        {
          name: "variant",
          default: "default",
          required: false,
          description: "Style hint",
          values: ["default", "primary", "borderless"],
        },
      ],
    },
    {
      name: "TextField",
      description: "A text input bound to a data model path.",
      properties: [
        { name: "label", required: true, description: "Field label" },
        { name: "value", required: false, description: "Bound value, normally { path }" },
        {
          name: "variant",
          default: "shortText",
          required: false,
          description: "Input kind",
          values: ["shortText", "longText", "number", "obscured"],
        },
        {
          name: "validationRegexp",
          required: false,
          description: "Client-side validation pattern",
        },
      ],
    },
    {
      name: "CheckBox",
      description: "A checkbox bound to a boolean in the data model.",
      properties: [
        { name: "label", required: true, description: "Text beside the box" },
        { name: "value", required: true, description: "Bound boolean, normally { path }" },
      ],
    },
    {
      name: "ChoicePicker",
      description: "A single- or multiple-choice picker over a fixed option list.",
      properties: [
        { name: "options", required: true, description: "Objects of { label, value }" },
        {
          name: "value",
          required: true,
          description: "Bound string array of selected values, normally { path }",
        },
        { name: "label", required: false, description: "Label for the group" },
        {
          name: "variant",
          default: "mutuallyExclusive",
          required: false,
          description: "Selection behaviour",
          values: ["mutuallyExclusive", "multipleSelection"],
        },
        {
          name: "displayStyle",
          default: "checkbox",
          required: false,
          description: "How options are drawn",
          values: ["checkbox", "chips"],
        },
        { name: "filterable", default: false, required: false, description: "Show a filter input" },
      ],
    },
    {
      name: "Slider",
      description: "A numeric slider bound to the data model.",
      properties: [
        { name: "value", required: true, description: "Bound number, normally { path }" },
        { name: "max", required: true, description: "Maximum value" },
        { name: "min", default: 0, required: false, description: "Minimum value" },
        { name: "label", required: false, description: "Slider label" },
      ],
    },
    {
      name: "DateTimeInput",
      description: "A date and/or time picker bound to an ISO 8601 string.",
      properties: [
        { name: "value", required: true, description: "Bound ISO 8601 string, normally { path }" },
        {
          name: "enableDate",
          default: false,
          required: false,
          description: "Allow picking a date",
        },
        {
          name: "enableTime",
          default: false,
          required: false,
          description: "Allow picking a time",
        },
        { name: "min", required: false, description: "Earliest allowed ISO 8601 value" },
        { name: "max", required: false, description: "Latest allowed ISO 8601 value" },
        { name: "label", required: false, description: "Field label" },
      ],
    },
  ],
};
