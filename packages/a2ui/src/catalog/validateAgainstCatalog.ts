/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { A2UIComponent, A2UIServerMessage } from "../protocol/messages";
import { isChildrenTemplate, isFunctionCall } from "../protocol/messages";
import { resolveValue } from "../protocol/binding";
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
    | "DANGLING_CHILD"
    | "CYCLIC_CHILD";
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
 */
function urlIssue(value: unknown, schemes: readonly string[]): string | undefined {
  // Anything that is not a string after resolution is not a URL a renderer can
  // fetch, so there is nothing to check. A BINDING is resolved before it gets
  // here — see `checkComponent` — because letting one through unexamined was
  // exactly the hole this check exists to close: the data model is written by
  // the same agent and nothing else scheme-checks it, so `{ "path": "/src" }`
  // carried a `javascript:` URL straight to the renderer.
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
  functions: readonly string[],
  dataModel: Readonly<Record<string, unknown>>
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
      // An absolute binding resolves here; a relative one inside a repeated
      // template reads a base path this check does not know, which is why
      // `dataModelUrlIssues` sweeps the model as well.
      const resolved = resolveValue(value, { dataModel, basePath: "" });
      const reason = urlIssue(resolved, schemes) ?? urlIssue(value, schemes);
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
/** Every string anywhere in a value, however deeply nested. */
function stringsIn(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) stringsIn(entry, into);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value as Record<string, unknown>)) stringsIn(entry, into);
  }
}

/**
 * Refuses a fetchable scheme anywhere in the data model of a surface that binds
 * a URL property.
 *
 * Blunt on purpose. A relative binding inside a repeated template reads a base
 * path decided while drawing, so there is no single value to resolve and check
 * — but every candidate it could read is somewhere in this model. Sweeping it
 * costs one walk and closes the case that per-property resolution cannot.
 *
 * It only runs for a surface that actually binds a URL somewhere, so a surface
 * that merely stores a string an agent never points a renderer at is untouched.
 */
function dataModelUrlIssues(
  surface: A2UISurfaceState,
  catalog: A2UICatalogSpec,
  schemes: readonly string[]
): readonly A2UICatalogIssue[] {
  const bindsAUrl = [...surface.components.values()].some((component) => {
    const spec = componentSpec(catalog, component.component);
    return spec?.properties.some(
      (property) => property.url && typeof component[property.name] === "object"
    );
  });
  if (!bindsAUrl) return [];

  const strings: string[] = [];
  stringsIn(surface.dataModel, strings);
  const issues: A2UICatalogIssue[] = [];
  for (const candidate of strings) {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) continue;
    const reason = urlIssue(candidate, schemes);
    if (!reason) continue;
    issues.push({
      surfaceId: surface.surfaceId,
      componentId: undefined,
      code: "BAD_URL",
      message: `surface "${surface.surfaceId}" binds a URL and its data model holds ${reason}`,
    });
  }
  return issues;
}

/**
 * A child reference that leads back to a component already being drawn.
 *
 * Nothing in the wire format forbids it — references are flat ids — and the
 * value-depth limit does not see it, because the cycle is in the graph rather
 * than in any one value. A renderer resolving children recursively follows it
 * until the stack runs out, which on a page is a frozen tab rather than an
 * error anyone can read.
 */
function cycleIssues(
  surface: A2UISurfaceState,
  catalog: A2UICatalogSpec
): readonly A2UICatalogIssue[] {
  const issues: A2UICatalogIssue[] = [];
  const done = new Set<string>();

  const walk = (id: string, ancestors: readonly string[]): void => {
    if (ancestors.includes(id)) {
      issues.push({
        surfaceId: surface.surfaceId,
        componentId: id,
        code: "CYCLIC_CHILD",
        message: `"${id}" is its own descendant, through ${[...ancestors.slice(ancestors.indexOf(id)), id].join(" → ")}`,
      });
      return;
    }
    // Revisiting a component by two different paths is ordinary reuse; only a
    // repeat along ONE path is a cycle, which is why `ancestors` is a path and
    // `done` merely stops the walk being exponential over a shared subtree.
    if (done.has(id)) return;
    done.add(id);
    const component = surface.components.get(id);
    if (!component) return;
    const next = [...ancestors, id];
    for (const child of referencedComponentIds(component, catalog)) walk(child, next);
  };

  walk(A2UI_ROOT_COMPONENT_ID, []);
  return issues;
}

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

  issues.push(...dataModelUrlIssues(surface, catalog, schemes));

  issues.push(...cycleIssues(surface, catalog));

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
    issues.push(
      ...checkComponent(
        component,
        surface.surfaceId,
        spec,
        schemes,
        catalog.functions,
        surface.dataModel
      )
    );
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
 * Folds a whole batch and checks it, message by message and as a whole.
 *
 * Both passes are needed and neither subsumes the other.
 *
 * Per message, because a connector applies messages in order: a batch can name
 * an unknown component and then replace it with a valid one, and a check that
 * only read the final fold would pass a batch whose second message is the only
 * safe thing in it.
 *
 * On the final fold, because the protocol's incremental idiom defines a
 * container before the children it names and patches a data model at a path
 * nothing has written yet — so root, dangling references, cycles and bound URLs
 * are only answerable once the batch has finished arriving.
 */
export function batchCatalogIssues(
  messages: Iterable<A2UIServerMessage>,
  options: A2UICatalogCheckOptions
): readonly A2UICatalogIssue[] {
  const { catalog } = options;
  const schemes = options.urlSchemes ?? DEFAULT_A2UI_URL_SCHEMES;
  const issues: A2UICatalogIssue[] = [];
  const seen = new Set<string>();

  let state: ReadonlyMap<string, A2UISurfaceState> = new Map();
  for (const message of messages) {
    state = foldSurfaces([message], state.values());
    if (!("updateComponents" in message)) continue;
    const surface = state.get(message.updateComponents.surfaceId);
    if (!surface) continue;
    for (const component of message.updateComponents.components) {
      const spec = componentSpec(catalog, component.component);
      if (!spec) {
        // Deduplicated by id and kind: a component redefined across several
        // messages would otherwise report the same fault once per definition.
        const key = `UNKNOWN_COMPONENT:${component.id}:${component.component}`;
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push({
          surfaceId: surface.surfaceId,
          componentId: component.id,
          code: "UNKNOWN_COMPONENT",
          message: `"${component.id}" is a ${component.component}, which this catalog has no component for`,
        });
        continue;
      }
      for (const issue of checkComponent(
        component,
        surface.surfaceId,
        spec,
        schemes,
        catalog.functions,
        surface.dataModel
      )) {
        const key = `${issue.code}:${issue.componentId}:${issue.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push(issue);
      }
    }
  }

  for (const surface of state.values()) {
    for (const issue of surfaceCatalogIssues(surface, options)) {
      const key = `${issue.code}:${issue.componentId}:${issue.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(issue);
    }
  }
  return issues;
}
