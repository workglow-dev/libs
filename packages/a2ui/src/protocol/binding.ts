/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { A2UIComponent, A2UIFunctionCall } from "./messages";
import { isChildrenTemplate, isDataBinding, isFunctionCall } from "./messages";

/**
 * A client-side function a component may call in place of a literal.
 *
 * A map rather than a fixed set: the catalog declares which names exist, and
 * what they DO is the host's, because two of them a host would be unwise to
 * hand over — anything that formats a date picks a locale, and anything that
 * opens a URL picks what "opening" means.
 */
export type A2UIFunctions = Readonly<Record<string, (args: Record<string, unknown>) => unknown>>;

/**
 * Where a value is being read from, which is not always the surface's root.
 *
 * `basePath` is what makes a repeated template work: the same component is
 * drawn once per item, and a relative path inside it reads that item. Without
 * it, every row of a list renders the first row's data — which looks like a
 * rendering bug and is actually a resolution one.
 */
export type A2UIResolveContext = {
  readonly dataModel: Readonly<Record<string, unknown>>;
  /** JSON pointer prefix for relative paths. Empty at the surface root. */
  readonly basePath: string;
  readonly functions?: A2UIFunctions;
};

/**
 * A path as an absolute pointer.
 *
 * A leading `/` means the surface's data model root and ignores the base;
 * anything else is relative to the item currently being drawn. This is the
 * whole of the protocol's scoping rule, and it is why a template's children can
 * say `{ "path": "title" }` and mean "this item's title".
 */
export function resolvePath(path: string, basePath: string): string {
  if (path.startsWith("/")) return path;
  if (path.length === 0) return basePath;
  return basePath.length === 0 ? `/${path}` : `${basePath}/${path}`;
}

/** Segments that never name data, however a pointer spells them. */
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * A pointer's segments, or `undefined` when it names something unreadable.
 *
 * Deliberately not {@link parsePointer}, which throws. A write has a caller to
 * report the error to; a READ happens while a renderer is drawing, on a path an
 * agent wrote, so throwing turns a bad binding into a blank card — or a crashed
 * one. Unreadable and absent answer the same way, because to a surface they are
 * the same thing.
 */
function readSegments(pointer: string): readonly string[] | undefined {
  if (pointer === "" || pointer === "/") return [];
  if (!pointer.startsWith("/")) return undefined;
  const segments = pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  return segments.some((segment) => RESERVED_SEGMENTS.has(segment)) ? undefined : segments;
}

/**
 * Reads whatever sits at a pointer, or `undefined`.
 *
 * Undefined rather than throwing: a surface routinely names a path before the
 * message that fills it arrives, and a renderer that threw would blank the
 * whole card on an ordering the protocol explicitly allows.
 *
 * Own properties only. Without that check `/toString` answers a function off
 * `Object.prototype` — a key the data model never held — and a host built-in
 * lands in a label, or in the context an action reports back to the agent.
 */
export function readPointer(
  dataModel: Readonly<Record<string, unknown>>,
  pointer: string
): unknown {
  const segments = readSegments(pointer);
  if (segments === undefined) return undefined;
  let cursor: unknown = dataModel;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return undefined;
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object") return undefined;
    if (!Object.hasOwn(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function callFunction(call: A2UIFunctionCall, context: A2UIResolveContext): unknown {
  const implementation = context.functions?.[call.call];
  // An unregistered function resolves to nothing rather than throwing. The
  // catalog check refuses a surface naming one before it is ever drawn, so
  // reaching here means a host registered fewer functions than its catalog
  // declares — one missing label, not a card that fails to open.
  if (!implementation) return undefined;
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(call.args)) {
    args[key] = resolveValue(value, context);
  }
  return implementation(args);
}

/**
 * One property value, with any binding or function call resolved.
 *
 * Applied one level deep into arrays and objects, because the catalog's own
 * shapes nest them: `ChoicePicker.options` is a list of objects whose `label`
 * may be bound, and an action's context is an object of them.
 */
export function resolveValue(value: unknown, context: A2UIResolveContext): unknown {
  if (isFunctionCall(value)) return callFunction(value, context);
  if (isDataBinding(value))
    return readPointer(context.dataModel, resolvePath(value.path, context.basePath));
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, context));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // `out.__proto__ = {…}` swaps the bag's prototype rather than landing as a
      // property, so every later read of an unset key answers out of what the
      // agent put there — and this bag becomes a component's props, or the
      // context an action reports back. The data model strips these on the way
      // in; a component's own properties never passed through that.
      if (RESERVED_SEGMENTS.has(key)) continue;
      out[key] = resolveValue(entry, context);
    }
    return out;
  }
  return value;
}

/**
 * Every property of a component with its bindings resolved, except the ones
 * naming other components.
 *
 * Those are skipped rather than resolved because a component id is not data: a
 * `children` array of ids would come back as a list of `undefined`, and a
 * `{ path, componentId }` template would be read as a binding and collapse to
 * whatever sits at that path. `id` and `component` are skipped for the same
 * reason — they address the component rather than describe it.
 */
export function resolveProps(
  component: A2UIComponent,
  context: A2UIResolveContext,
  structuralProps: readonly string[] = []
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(component)) {
    if (key === "id" || key === "component") continue;
    if (structuralProps.includes(key)) continue;
    // Same reason as {@link resolveValue}: a component property spelled
    // `__proto__` re-prototypes the props bag instead of becoming one of them.
    if (RESERVED_SEGMENTS.has(key)) continue;
    out[key] = resolveValue(value, context);
  }
  return out;
}

/** One child to draw, and the data it reads through. */
export type A2UIChildSlot = {
  readonly componentId: string;
  /** Pointer prefix for the child's relative paths. */
  readonly basePath: string;
  /** Stable across re-renders for the same item, for a list key. */
  readonly key: string;
};

/**
 * A `children` value as the list of children to actually draw.
 *
 * Both spellings land here: a static array of ids, and a template repeated over
 * a data-model array. The template's base path is what each copy reads through,
 * so the Nth row sees the Nth item — see {@link A2UIResolveContext}.
 *
 * A template over a path holding no array draws nothing. That is not an error:
 * the protocol's incremental idiom fills a list after the component that
 * repeats over it, so "not an array yet" is a normal intermediate state.
 */
export function expandChildren(
  value: unknown,
  context: A2UIResolveContext
): readonly A2UIChildSlot[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((componentId, index) => ({
        componentId,
        basePath: context.basePath,
        key: `${componentId}:${index}`,
      }));
  }
  if (!isChildrenTemplate(value)) return [];
  const pointer = resolvePath(value.path, context.basePath);
  const items = readPointer(context.dataModel, pointer);
  if (!Array.isArray(items)) return [];
  return items.map((_item, index) => ({
    componentId: value.componentId,
    basePath: `${pointer}/${index}`,
    key: `${value.componentId}:${pointer}/${index}`,
  }));
}

/**
 * Where a two-way bound control writes.
 *
 * A control whose `value` is a literal rather than a binding has nowhere to
 * write, and answers `undefined` — the agent described a field it did not wire
 * to its data model, which is its mistake to see in the surface rather than one
 * to guess a destination for.
 */
export function writeTargetOf(value: unknown, context: A2UIResolveContext): string | undefined {
  if (!isDataBinding(value)) return undefined;
  const pointer = resolvePath(value.path, context.basePath);
  // A control bound to an unwritable pointer has nowhere to go either: handing
  // one back would move the refusal into the host's write path, where it
  // arrives as a throw mid-keystroke rather than as a field that does not
  // collect.
  return readSegments(pointer) === undefined ? undefined : pointer;
}

/** An action's context with its bindings resolved, ready to report to the agent. */
export function resolveActionContext(
  actionContext: unknown,
  context: A2UIResolveContext
): Record<string, unknown> {
  const resolved = resolveValue(actionContext, context);
  if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) return {};
  return resolved as Record<string, unknown>;
}
