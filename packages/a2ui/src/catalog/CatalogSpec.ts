/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One property a component accepts, as much of it as a host needs to know.
 *
 * Deliberately not the catalog's JSON Schema. A renderer validates against that
 * schema and is welcome to; what a host needs is three answers the schema
 * states only indirectly — does this property name another component, does it
 * carry a URL, and what does an agent need to be told about it. Re-deriving
 * those from `$ref` chains at every call site is how the URL check came to be
 * applied to `Image.url` and not `Video.url`.
 */
export type A2UIPropertySpec = {
  readonly name: string;
  readonly required: boolean;
  /** One line for the agent's prompt. */
  readonly description: string;
  /** Allowed literal values, when the property is a closed set. */
  readonly values?: readonly string[];
  /**
   * How this property names other components, if it does.
   *
   * - "id": the value is one component id.
   * - "children": a list of ids, or a `{ path, componentId }` template.
   * - "item-child": a list of objects, each naming one id under `child`.
   */
  readonly references?: "id" | "children" | "item-child";
  /** Whether the value is fetched by the renderer, and so needs a scheme check. */
  readonly url?: boolean;
};

export type A2UIComponentSpec = {
  readonly name: string;
  readonly description: string;
  readonly properties: readonly A2UIPropertySpec[];
};

export type A2UICatalogSpec = {
  readonly catalogId: string;
  readonly title: string;
  readonly components: readonly A2UIComponentSpec[];
  /**
   * Client-side functions a component may call instead of dispatching an event.
   *
   * Named rather than described in full: a host that registers none still has
   * to refuse the ones an agent asks for, and the name is what it refuses by.
   */
  readonly functions: readonly string[];
};

/** The spec for one component name, or undefined when the catalog has none. */
export function componentSpec(
  catalog: A2UICatalogSpec,
  name: string
): A2UIComponentSpec | undefined {
  return catalog.components.find((component) => component.name === name);
}
