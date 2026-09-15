/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HumanResponseAction } from "./HumanConnector";

/** One value a person reads before answering, under the label to read it by. */
export interface HumanPromptDetail {
  readonly label: string;
  readonly value: string;
}

/**
 * How a request is drawn, and therefore what it can be answered with.
 *
 * - "acknowledge": one-way. There is nothing to decide.
 * - "form": fields to fill in. The answer IS the data.
 * - "approval": one described action. The answer is a decision, and the
 *   description is read rather than edited.
 */
export type HumanPromptShape = "acknowledge" | "form" | "approval";

export interface HumanPromptModel {
  readonly shape: HumanPromptShape;
  /** Heading for the panel or card. */
  readonly title: string;
  readonly message: string;
  /** Read-only values. Empty for a form, whose values are the person's to write. */
  readonly details: readonly HumanPromptDetail[];
  /** Every answer the rendering offers, in the order it offers them. */
  readonly actions: readonly HumanResponseAction[];
  /** Whether an accepted answer carries data back to the caller. */
  readonly carriesContent: boolean;
}

/**
 * The request as both renderers see it. The Ink host holds an `IHumanRequest`;
 * the console receives the same fields off the run's event stream.
 */
export interface HumanPromptSource {
  readonly kind: string;
  readonly message: string;
  readonly schema: unknown;
  readonly data: unknown;
}

/**
 * A detail occupies one row, whatever it contains.
 *
 * `contentData` is an input port on `HumanInputTask`, so its values are as
 * reachable as anything else a model supplies; a line break left in one lets a
 * value draw further labelled rows of its own.
 */
function oneLine(text: string): string {
  return text.replace(/\r\n|[\n\r\u2028\u2029]/g, "\\n");
}

function detailsOf(schema: unknown, data: unknown): HumanPromptDetail[] {
  if (typeof data !== "object" || data === null) return [];
  const properties = (schema as { properties?: Record<string, { title?: unknown }> } | null)
    ?.properties;
  return Object.entries(data as Record<string, unknown>).map(([key, value]) => {
    const title = properties?.[key]?.title;
    const label = typeof title === "string" && title ? title : key;
    const rendered = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
    return { label: oneLine(label), value: oneLine(rendered) };
  });
}

/**
 * What to draw for one human request, decided once for both renderers.
 *
 * Kept renderer-free so the Ink panel and the web console cannot disagree about
 * what a request is asking — the case that matters is "confirm", where drawing
 * a form instead of an approval turns the description of an action into fields
 * to edit and leaves a person no way to say no.
 */
export function humanPromptModel(source: HumanPromptSource): HumanPromptModel {
  if (source.kind === "notify" || source.kind === "display") {
    return {
      shape: "acknowledge",
      title: source.kind === "notify" ? "Notice" : "Display",
      message: source.message,
      details: detailsOf(source.schema, source.data),
      actions: ["accept", "cancel"],
      carriesContent: false,
    };
  }
  if (source.kind === "confirm") {
    // The schema describes the action, so its fields are values to read. Drawn
    // as a form they become inputs to edit, the edits come back as the task's
    // output, and the one answer an approval exists for — "no" — has nowhere to
    // be pressed. "decline" is a refusal; "cancel" is walking away undecided,
    // and a caller acts differently on each.
    return {
      shape: "approval",
      title: "Approval required",
      message: source.message,
      details: detailsOf(source.schema, source.data),
      actions: ["accept", "decline", "cancel"],
      carriesContent: false,
    };
  }
  return {
    shape: "form",
    title: "Input required",
    message: source.message,
    details: [],
    actions: ["accept", "cancel"],
    carriesContent: true,
  };
}
