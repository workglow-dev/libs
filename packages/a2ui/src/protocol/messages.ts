/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The only protocol version this package speaks.
 *
 * Every message carries it, and a renderer keys its component schemas off it,
 * so a message tagged with anything else is refused rather than guessed at: a
 * later version can move a property from one component to another, and a
 * renderer reading it under this version's rules would draw something the agent
 * did not describe.
 */
export const A2UI_VERSION = "v0.9";

/** A value a component reads out of its surface's data model. */
export type A2UIDataBinding = {
  readonly path: string;
};

/** A value a component computes by calling one of the catalog's functions. */
export type A2UIFunctionCall = {
  readonly call: string;
  readonly args: Record<string, unknown>;
  readonly returnType?: "string" | "number" | "boolean" | "array" | "object" | "any" | "void";
};

/**
 * One component in a surface's adjacency list.
 *
 * The protocol is deliberately open here: `component` names an entry in the
 * surface's catalog, and every other key is that component's own property,
 * whose shape only the catalog knows. {@link validateComponentsAgainstCatalog}
 * is what closes it.
 */
export type A2UIComponent = {
  readonly id: string;
  readonly component: string;
  readonly [property: string]: unknown;
};

/** Children given as a template repeated over a data-model array. */
export type A2UIChildrenTemplate = {
  readonly path: string;
  readonly componentId: string;
};

export type A2UICreateSurface = {
  readonly surfaceId: string;
  readonly catalogId: string;
  readonly theme?: Record<string, unknown>;
  readonly sendDataModel?: boolean;
};

export type A2UIUpdateComponents = {
  readonly surfaceId: string;
  readonly components: readonly A2UIComponent[];
};

export type A2UIUpdateDataModel = {
  readonly surfaceId: string;
  /** JSON pointer into the surface's data model; `/` or absent means the root. */
  readonly path?: string;
  /** Absent removes whatever sits at `path`. */
  readonly value?: unknown;
};

export type A2UIDeleteSurface = {
  readonly surfaceId: string;
};

export type A2UICreateSurfaceMessage = {
  readonly version: typeof A2UI_VERSION;
  readonly createSurface: A2UICreateSurface;
};

export type A2UIUpdateComponentsMessage = {
  readonly version: typeof A2UI_VERSION;
  readonly updateComponents: A2UIUpdateComponents;
};

export type A2UIUpdateDataModelMessage = {
  readonly version: typeof A2UI_VERSION;
  readonly updateDataModel: A2UIUpdateDataModel;
};

export type A2UIDeleteSurfaceMessage = {
  readonly version: typeof A2UI_VERSION;
  readonly deleteSurface: A2UIDeleteSurface;
};

/** One message from the agent to the renderer. */
export type A2UIServerMessage =
  | A2UICreateSurfaceMessage
  | A2UIUpdateComponentsMessage
  | A2UIUpdateDataModelMessage
  | A2UIDeleteSurfaceMessage;

/** The object form of a message list, for transports that carry no bare array. */
export type A2UIServerMessageList = {
  readonly messages: readonly A2UIServerMessage[];
};

/** What a person did, reported back to the agent with its bindings resolved. */
export type A2UIUserAction = {
  readonly name: string;
  readonly surfaceId: string;
  readonly sourceComponentId: string;
  /** ISO 8601. */
  readonly timestamp: string;
  readonly context: Record<string, unknown>;
};

/** A renderer refusing something the agent sent, in the agent's terms. */
export type A2UIClientError = {
  readonly code: string;
  readonly surfaceId: string;
  readonly message: string;
  /** JSON pointer at the offending value, for `VALIDATION_FAILED`. */
  readonly path?: string;
};

export type A2UIActionMessage = {
  readonly version: typeof A2UI_VERSION;
  readonly action: A2UIUserAction;
};

export type A2UIErrorMessage = {
  readonly version: typeof A2UI_VERSION;
  readonly error: A2UIClientError;
};

/** One message from the renderer back to the agent. */
export type A2UIClientMessage = A2UIActionMessage | A2UIErrorMessage;

/** The four message kinds, as the key each one is carried under. */
export const A2UI_SERVER_MESSAGE_KINDS = [
  "createSurface",
  "updateComponents",
  "updateDataModel",
  "deleteSurface",
] as const;

export type A2UIServerMessageKind = (typeof A2UI_SERVER_MESSAGE_KINDS)[number];

/** Which of the four a message is, without narrowing it first. */
export function serverMessageKind(message: A2UIServerMessage): A2UIServerMessageKind {
  if ("createSurface" in message) return "createSurface";
  if ("updateComponents" in message) return "updateComponents";
  if ("updateDataModel" in message) return "updateDataModel";
  return "deleteSurface";
}

/** The surface every message names, whichever kind it is. */
export function surfaceIdOf(message: A2UIServerMessage): string {
  if ("createSurface" in message) return message.createSurface.surfaceId;
  if ("updateComponents" in message) return message.updateComponents.surfaceId;
  if ("updateDataModel" in message) return message.updateDataModel.surfaceId;
  return message.deleteSurface.surfaceId;
}

/** True when `children` is a template over a data-model array rather than a list of ids. */
export function isChildrenTemplate(value: unknown): value is A2UIChildrenTemplate {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { componentId?: unknown }).componentId === "string"
  );
}

/** True when a property value is a call into the catalog's function set. */
export function isFunctionCall(value: unknown): value is A2UIFunctionCall {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { call?: unknown }).call === "string" &&
    typeof (value as { args?: unknown }).args === "object" &&
    (value as { args?: unknown }).args !== null
  );
}

/** True when a property value is a data binding rather than a literal. */
export function isDataBinding(value: unknown): value is A2UIDataBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { path?: unknown }).path === "string" &&
    !("componentId" in (value as object))
  );
}
