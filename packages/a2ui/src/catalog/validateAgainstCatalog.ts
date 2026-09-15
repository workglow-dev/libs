/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { A2UIComponent, A2UIServerMessage } from "../protocol/messages";
import { isChildrenTemplate, isFunctionCall } from "../protocol/messages";
import type { A2UISurfaceState } from "../protocol/surfaces";
import { A2UI_ROOT_COMPONENT_ID, foldSurfaces } from "../protocol/surfaces";
import type { A2UICatalogSpec, A2UIComponentSpec, A2UIPropertySpec } from "./CatalogSpec";
import { componentSpec } from "./CatalogSpec";

/**
 * URL schemes a renderer may fetch on an agent's say-so.
 *
 * The agent writes these strings, so the scheme is the agent's choice unless
 * something narrows it. `javascript:` executes in the surface's own page,
 * `data:` smuggles arbitrary markup past the component allowlist the catalog
 * exists to be, and `file:` reads the host — none of which the catalog's own
 * schema refuses, because it types these properties as plain strings.
 *
 * `http:` is here because a surface may legitimately be drawn against a local
 * development server; nothing else is, and a host wanting more says so.
 */
export const DEFAULT_A2UI_URL_SCHEMES: readonly string[] = Object.freeze(["https:", "http:"]);

export type A2UICatalogIssue = {
  readonly surfaceId: string;
  readonly componentId: string | undefined;
  readonly code:
    | "UNKNOWN_CATALOG"
    | "UNKNOWN_COMPONENT"
    | "UNKNOWN_PROPERTY"
    | "MISSING_PROPERTY"
    | "BAD_VALUE"
    | "BAD_URL"
    | "UNKNOWN_FUNCTION"
    | "MISSING_ROOT"
    | "DANGLING_CHILD";
  readonly message: string;
};

export type A2UICatalogCheckOptions = {
  readonly catalog: A2UICatalogSpec;
  readonly urlSchemes?: readonly string[];
};

/** Component ids one property names, given what the catalog says that property is. */
function referencedIds(spec: A2UIPropertySpec, value: unknown): readonly string[] {
  if (spec.references === "id") return typeof value === "string" ? [value] : [];
  if (spec.references === "children") {
    if (Array.isArray(value))
      return value.filter((entry): entry is string => typeof entry === "string");
    if (isChildrenTemplate(value)) return [value.componentId];
    return [];
  }
  if (spec.references === "item-child" && Array.isArray(value)) {
    const ids: string[] = [];
    for (const item of value) {
      if (typeof item !== "object" || item === null) continue;
      const child = (item as { child?: unknown }).child;
      if (typeof child === "string") ids.push(child);
    }
    return ids;
  }
  return [];
}

/**
 * Every component id one component names, whatever property carries it.
 *
 * Catalog-driven rather than a fixed list of property names: the basic catalog
 * alone spells this four ways (`children`, `child`, `tabs[].child`, and
 * `Modal`'s `trigger`/`content`), and a hard-coded reader that misses one
 * reports the components under it as unreachable — or, worse, never notices
 * that an id they name was never defined.
 */
export function referencedComponentIds(
  component: A2UIComponent,
  catalog: A2UICatalogSpec
): readonly string[] {
  const spec = componentSpec(catalog, component.component);
  if (!spec) return [];
  const ids: string[] = [];
  for (const property of spec.properties) {
    if (!property.references) continue;
    ids.push(...referencedIds(property, component[property.name]));
  }
  return ids;
}

/**
 * Whether a URL property is one a renderer may fetch.
 *
 * A binding is let through: its value comes out of the data model, which the
 * same batch wrote and the same checks covered, and refusing it here would ban
 * the one idiom the protocol recommends for images in a repeated list.
 */
function urlIssue(value: unknown, schemes: readonly string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `"${value.slice(0, 80)}" is not an absolute URL`;
  }
  if (!schemes.includes(parsed.protocol)) {
    return `scheme "${parsed.protocol}" is not one of ${schemes.join(", ")}`;
  }
  return undefined;
}

/**
 * Every function name reached anywhere inside a value.
 *
 * A call can sit at any depth — a button's `action` context, one option's
 * label, an argument of another call — so this walks rather than reading the
 * top level. The catalog names its functions for the same reason it names its
 * components, and a name it does not list is one no host implements: left
 * unchecked it resolves to `undefined` and draws an empty label, which reads as
 * missing data rather than as a surface asking for something that does not
 * exist.
 */
function functionNamesIn(value: unknown, into: Set<string>): void {
  if (isFunctionCall(value)) {
    into.add(value.call);
    for (const arg of Object.values(value.args)) functionNamesIn(arg, into);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) functionNamesIn(entry, into);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value as Record<string, unknown>))
      functionNamesIn(entry, into);
  }
}

function checkComponent(
  component: A2UIComponent,
  surfaceId: string,
  spec: A2UIComponentSpec,
  schemes: readonly string[],
  functions: readonly string[]
): readonly A2UICatalogIssue[] {
  const issues: A2UICatalogIssue[] = [];
  const at = { surfaceId, componentId: component.id };
  const known = new Map(spec.properties.map((property) => [property.name, property]));

  const called = new Set<string>();
  for (const [key, value] of Object.entries(component)) {
    if (key === "id" || key === "component") continue;
    functionNamesIn(value, called);
  }
  for (const name of called) {
    if (functions.includes(name)) continue;
    issues.push({
      ...at,
      code: "UNKNOWN_FUNCTION",
      message: `"${component.id}" calls "${name}", which this catalog has no function for`,
    });
  }

  for (const property of spec.properties) {
    if (property.required && component[property.name] === undefined) {
      issues.push({
        ...at,
        code: "MISSING_PROPERTY",
        message: `${spec.name} "${component.id}" is missing required property "${property.name}"`,
      });
    }
  }

  for (const [key, value] of Object.entries(component)) {
    if (key === "id" || key === "component") continue;
    const property = known.get(key);
    if (!property) {
      issues.push({
        ...at,
        code: "UNKNOWN_PROPERTY",
        message: `${spec.name} "${component.id}" sets "${key}", which ${spec.name} has no property for`,
      });
      continue;
    }
    if (property.values && typeof value === "string" && !property.values.includes(value)) {
      issues.push({
        ...at,
        code: "BAD_VALUE",
        message: `${spec.name} "${component.id}" sets ${key} to "${value}"; allowed: ${property.values.join(", ")}`,
      });
    }
    if (property.url) {
      const reason = urlIssue(value, schemes);
      if (reason) {
        issues.push({
          ...at,
          code: "BAD_URL",
          message: `${spec.name} "${component.id}" property ${key}: ${reason}`,
        });
      }
    }
  }
  return issues;
}

/**
 * Checks one folded surface against the catalog it named.
 *
 * This is the check A2UI's safety argument rests on, and it is the reason the
 * catalog is a table in this repository rather than a URL: "the agent may only
 * ask for components you already implement" is only true where something
 * refuses the ones it does not. A renderer that silently skips an unknown
 * component makes an over-reaching agent look like a quiet one.
 */
export function surfaceCatalogIssues(
  surface: A2UISurfaceState,
  options: A2UICatalogCheckOptions
): readonly A2UICatalogIssue[] {
  const { catalog } = options;
  const schemes = options.urlSchemes ?? DEFAULT_A2UI_URL_SCHEMES;
  const issues: A2UICatalogIssue[] = [];

  if (surface.catalogId !== catalog.catalogId) {
    return [
      {
        surfaceId: surface.surfaceId,
        componentId: undefined,
        code: "UNKNOWN_CATALOG",
        message: `surface "${surface.surfaceId}" asks for catalog "${surface.catalogId}"; this host serves "${catalog.catalogId}"`,
      },
    ];
  }

  if (!surface.components.has(A2UI_ROOT_COMPONENT_ID)) {
    issues.push({
      surfaceId: surface.surfaceId,
      componentId: undefined,
      code: "MISSING_ROOT",
      message: `surface "${surface.surfaceId}" defines no component with id "${A2UI_ROOT_COMPONENT_ID}"`,
    });
  }

  for (const component of surface.components.values()) {
    const spec = componentSpec(catalog, component.component);
    if (!spec) {
      issues.push({
        surfaceId: surface.surfaceId,
        componentId: component.id,
        code: "UNKNOWN_COMPONENT",
        message: `"${component.id}" is a ${component.component}, which this catalog has no component for`,
      });
      continue;
    }
    issues.push(...checkComponent(component, surface.surfaceId, spec, schemes, catalog.functions));
    for (const id of referencedComponentIds(component, catalog)) {
      if (surface.components.has(id)) continue;
      issues.push({
        surfaceId: surface.surfaceId,
        componentId: component.id,
        code: "DANGLING_CHILD",
        message: `"${component.id}" names a child "${id}" that no message defines`,
      });
    }
  }
  return issues;
}

/**
 * Folds a whole batch and checks every surface it leaves behind.
 *
 * Batch-wide rather than per surface because the protocol's incremental idiom
 * defines a container before the children it names, and a delete may retire a
 * surface an earlier message created — so the only state worth checking is the
 * one the batch ends in.
 */
export function batchCatalogIssues(
  messages: Iterable<A2UIServerMessage>,
  options: A2UICatalogCheckOptions
): readonly A2UICatalogIssue[] {
  const issues: A2UICatalogIssue[] = [];
  for (const surface of foldSurfaces(messages).values()) {
    issues.push(...surfaceCatalogIssues(surface, options));
  }
  return issues;
}
