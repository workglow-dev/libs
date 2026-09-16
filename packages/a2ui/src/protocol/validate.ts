/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { A2UIClientMessage, A2UIComponent, A2UIServerMessage } from "./messages";
import { A2UI_SERVER_MESSAGE_KINDS, A2UI_VERSION } from "./messages";
import { parsePointer } from "./dataModel";

/**
 * Bounds on an A2UI batch a language model wrote.
 *
 * A2UI's premise is that a surface is safe because the catalog is an allowlist,
 * and that holds for what a component may BE. It says nothing about how many
 * there are: a renderer builds one live node per component and one subscription
 * per binding, so an agent that emits ten thousand of them hangs the tab it was
 * asked to draw a card in. The catalog is the allowlist; this is the budget.
 */
export type A2UIValidationLimits = {
  /** Messages in one batch. */
  readonly maxMessages: number;
  /** Components in one `updateComponents`, and in one surface overall. */
  readonly maxComponents: number;
  /** Properties on one component, its `id` and `component` included. */
  readonly maxComponentProperties: number;
  /** Nesting inside one component property, and inside one data model value. */
  readonly maxValueDepth: number;
  /** Characters in any one string, whether an id, a property or a data value. */
  readonly maxStringLength: number;
  /** Surfaces one batch may have created. */
  readonly maxSurfaces: number;
};

export const DEFAULT_A2UI_VALIDATION_LIMITS: A2UIValidationLimits = Object.freeze({
  maxMessages: 64,
  maxComponents: 256,
  maxComponentProperties: 32,
  maxValueDepth: 8,
  maxStringLength: 20_000,
  maxSurfaces: 8,
});

export type A2UIValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

function fail<T>(reason: string): A2UIValidationResult<T> {
  return { ok: false, reason };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkString(
  value: unknown,
  where: string,
  limits: A2UIValidationLimits
): string | undefined {
  if (typeof value !== "string") return `${where} must be a string`;
  if (value.length === 0) return `${where} must not be empty`;
  if (value.length > limits.maxStringLength) {
    return `${where} is longer than ${limits.maxStringLength} characters`;
  }
  return undefined;
}

/**
 * A pointer, which unlike every other string on the wire may be empty.
 *
 * `""` and `"/"` both name the root, so {@link checkString}'s non-empty rule
 * refuses a message {@link parsePointer} parses and the root check below is
 * written to expect. An empty `surfaceId` names nothing; an empty pointer names
 * the whole model.
 */
function checkPointer(
  value: unknown,
  where: string,
  limits: A2UIValidationLimits
): string | undefined {
  if (typeof value !== "string") return `${where} must be a string`;
  if (value.length > limits.maxStringLength) {
    return `${where} is longer than ${limits.maxStringLength} characters`;
  }
  return undefined;
}

/**
 * Walks a JSON value the agent wrote, bounding depth and string length.
 *
 * Depth rather than total size because the cost a renderer pays is per node:
 * a binding resolver walks a value on every data change, so a deeply nested
 * property is re-walked once per keystroke in whatever field reads it.
 */
function checkValue(
  value: unknown,
  where: string,
  depth: number,
  limits: A2UIValidationLimits
): string | undefined {
  if (depth > limits.maxValueDepth) return `${where} nests deeper than ${limits.maxValueDepth}`;
  if (typeof value === "string") {
    if (value.length > limits.maxStringLength) {
      return `${where} is longer than ${limits.maxStringLength} characters`;
    }
    return undefined;
  }
  if (typeof value === "function" || typeof value === "bigint" || typeof value === "symbol") {
    return `${where} is not JSON`;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const reason = checkValue(value[i], `${where}/${i}`, depth + 1, limits);
      if (reason) return reason;
    }
    return undefined;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const reason = checkValue(entry, `${where}/${key}`, depth + 1, limits);
      if (reason) return reason;
    }
    return undefined;
  }
  return undefined;
}

function checkComponent(
  value: unknown,
  where: string,
  limits: A2UIValidationLimits
): string | undefined {
  if (!isPlainObject(value)) return `${where} must be an object`;
  const keys = Object.keys(value);
  if (keys.length > limits.maxComponentProperties) {
    return `${where} has more than ${limits.maxComponentProperties} properties`;
  }
  const idReason = checkString(value.id, `${where}/id`, limits);
  if (idReason) return idReason;
  const componentReason = checkString(value.component, `${where}/component`, limits);
  if (componentReason) return componentReason;
  for (const key of keys) {
    if (key === "id" || key === "component") continue;
    const reason = checkValue(value[key], `${where}/${key}`, 1, limits);
    if (reason) return reason;
  }
  return undefined;
}

const ALLOWED_BODY_KEYS: Record<string, readonly string[]> = {
  createSurface: ["surfaceId", "catalogId", "theme", "sendDataModel"],
  updateComponents: ["surfaceId", "components"],
  updateDataModel: ["surfaceId", "path", "value"],
  deleteSurface: ["surfaceId"],
};

/**
 * One server-to-client message, checked structurally.
 *
 * The protocol's own schema is `oneOf` over four shapes with
 * `additionalProperties: false`, so a message carrying two of the four keys is
 * refused rather than served by whichever the reader happens to test first.
 * That is not pedantry: `createSurface` + `deleteSurface` in one object would
 * be read one way here and the other way by a peer renderer.
 */
export function validateServerMessage(
  value: unknown,
  limits: A2UIValidationLimits = DEFAULT_A2UI_VALIDATION_LIMITS
): A2UIValidationResult<A2UIServerMessage> {
  if (!isPlainObject(value)) return fail("a message must be an object");
  if (value.version !== A2UI_VERSION) {
    return fail(`a message must carry version "${A2UI_VERSION}"`);
  }
  const kinds = A2UI_SERVER_MESSAGE_KINDS.filter((kind) => kind in value);
  if (kinds.length === 0) {
    return fail(`a message must carry one of ${A2UI_SERVER_MESSAGE_KINDS.join(", ")}`);
  }
  if (kinds.length > 1) return fail(`a message carries ${kinds.join(" and ")}; it may carry one`);
  const extra = Object.keys(value).filter((key) => key !== "version" && key !== kinds[0]);
  if (extra.length > 0) return fail(`a message carries unknown keys: ${extra.join(", ")}`);

  const kind = kinds[0]!;
  const body = value[kind];
  if (!isPlainObject(body)) return fail(`${kind} must be an object`);
  const surfaceReason = checkString(body.surfaceId, `${kind}/surfaceId`, limits);
  if (surfaceReason) return fail(surfaceReason);

  switch (kind) {
    case "createSurface": {
      const catalogReason = checkString(body.catalogId, "createSurface/catalogId", limits);
      if (catalogReason) return fail(catalogReason);
      if (body.theme !== undefined) {
        if (!isPlainObject(body.theme)) return fail("createSurface/theme must be an object");
        const reason = checkValue(body.theme, "createSurface/theme", 1, limits);
        if (reason) return fail(reason);
      }
      if (body.sendDataModel !== undefined && typeof body.sendDataModel !== "boolean") {
        return fail("createSurface/sendDataModel must be a boolean");
      }
      break;
    }
    case "updateComponents": {
      const components = body.components;
      if (!Array.isArray(components) || components.length === 0) {
        return fail("updateComponents/components must be a non-empty array");
      }
      if (components.length > limits.maxComponents) {
        return fail(`updateComponents/components holds more than ${limits.maxComponents} entries`);
      }
      const seen = new Set<string>();
      for (let i = 0; i < components.length; i++) {
        const reason = checkComponent(components[i], `updateComponents/components/${i}`, limits);
        if (reason) return fail(reason);
        const id = (components[i] as A2UIComponent).id;
        // One id twice in one message leaves which definition wins to the
        // renderer's iteration order, and the agent meant one of them.
        if (seen.has(id)) return fail(`updateComponents defines "${id}" twice`);
        seen.add(id);
      }
      break;
    }
    case "updateDataModel": {
      if (body.path !== undefined) {
        const pathReason = checkPointer(body.path, "updateDataModel/path", limits);
        if (pathReason) return fail(pathReason);
        try {
          parsePointer(body.path as string);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      }
      if ("value" in body) {
        const reason = checkValue(body.value, "updateDataModel/value", 1, limits);
        if (reason) return fail(reason);
        // A data model's root is an object. Left to the fold this is an
        // `A2UIPointerError` thrown from inside whoever folds the batch, rather
        // than the refusal every other malformed message gets.
        const atRoot = body.path === undefined || body.path === "/" || body.path === "";
        const value = body.value;
        if (atRoot && (typeof value !== "object" || value === null || Array.isArray(value))) {
          return fail("updateDataModel at the root must carry an object");
        }
      }
      break;
    }
    case "deleteSurface":
      break;
  }

  const bodyExtra = Object.keys(body).filter((key) => !ALLOWED_BODY_KEYS[kind].includes(key));
  if (bodyExtra.length > 0) return fail(`${kind} carries unknown keys: ${bodyExtra.join(", ")}`);
  return { ok: true, value: value as unknown as A2UIServerMessage };
}

/**
 * A whole batch, checked message by message and then as a sequence.
 *
 * The sequence checks are what a per-message check cannot see: a surface
 * updated before it was created is not a malformed message, it is a batch a
 * renderer drops half of — and it drops it silently, because the protocol says
 * an update names a surface the reader is expected to already hold.
 */
export function validateServerMessages(
  value: unknown,
  limits: A2UIValidationLimits = DEFAULT_A2UI_VALIDATION_LIMITS
): A2UIValidationResult<readonly A2UIServerMessage[]> {
  const list = isPlainObject(value) && "messages" in value ? value.messages : value;
  if (!Array.isArray(list)) return fail("a batch must be an array of messages");
  if (list.length === 0) return fail("a batch must hold at least one message");
  if (list.length > limits.maxMessages) {
    return fail(`a batch holds more than ${limits.maxMessages} messages`);
  }

  const messages: A2UIServerMessage[] = [];
  const open = new Set<string>();
  // Live ids, not definitions sent. The fold treats a later definition of an id
  // as a replacement, so counting every definition rejects the protocol's own
  // idiom — a surface that updates the same handful of components as a person
  // interacts with it hits a "too many components" refusal while holding a
  // handful.
  const liveIds = new Map<string, Set<string>>();
  let created = 0;
  for (let i = 0; i < list.length; i++) {
    const result = validateServerMessage(list[i], limits);
    if (!result.ok) return fail(`message ${i}: ${result.reason}`);
    const message = result.value;
    if ("createSurface" in message) {
      const id = message.createSurface.surfaceId;
      if (open.has(id)) return fail(`message ${i}: surface "${id}" already exists`);
      if (++created > limits.maxSurfaces) {
        return fail(`a batch creates more than ${limits.maxSurfaces} surfaces`);
      }
      open.add(id);
      liveIds.set(id, new Set());
    } else {
      const id =
        "updateComponents" in message
          ? message.updateComponents.surfaceId
          : "updateDataModel" in message
            ? message.updateDataModel.surfaceId
            : message.deleteSurface.surfaceId;
      if (!open.has(id)) return fail(`message ${i}: surface "${id}" was never created`);
      if ("updateComponents" in message) {
        const live = liveIds.get(id) ?? new Set<string>();
        for (const component of message.updateComponents.components) live.add(component.id);
        if (live.size > limits.maxComponents) {
          return fail(`surface "${id}" holds more than ${limits.maxComponents} components`);
        }
        liveIds.set(id, live);
      }
      if ("deleteSurface" in message) open.delete(id);
    }
    messages.push(message);
  }
  return { ok: true, value: messages };
}

/** One client-to-server message, checked the same way. */
export function validateClientMessage(
  value: unknown,
  limits: A2UIValidationLimits = DEFAULT_A2UI_VALIDATION_LIMITS
): A2UIValidationResult<A2UIClientMessage> {
  if (!isPlainObject(value)) return fail("a message must be an object");
  if (value.version !== A2UI_VERSION) {
    return fail(`a message must carry version "${A2UI_VERSION}"`);
  }
  const hasAction = "action" in value;
  const hasError = "error" in value;
  if (hasAction === hasError) return fail("a message must carry exactly one of action, error");
  // Closed for the same reason the server side is: a caller that cannot rely on
  // the shape has to re-check every field it reads, and the one field nobody
  // re-checks is the one an extra payload rides in on.
  const extra = Object.keys(value).filter(
    (key) => key !== "version" && key !== "action" && key !== "error"
  );
  if (extra.length > 0) return fail(`a message carries unknown keys: ${extra.join(", ")}`);

  if (hasAction) {
    const action = value.action;
    if (!isPlainObject(action)) return fail("action must be an object");
    for (const field of ["name", "surfaceId", "sourceComponentId", "timestamp"]) {
      const reason = checkString(action[field], `action/${field}`, limits);
      if (reason) return fail(reason);
    }
    if (!isPlainObject(action.context)) return fail("action/context must be an object");
    const reason = checkValue(action.context, "action/context", 1, limits);
    if (reason) return fail(reason);
    return { ok: true, value: value as unknown as A2UIClientMessage };
  }

  const error = value.error;
  if (!isPlainObject(error)) return fail("error must be an object");
  for (const field of ["code", "surfaceId", "message"]) {
    const reason = checkString(error[field], `error/${field}`, limits);
    if (reason) return fail(reason);
  }
  return { ok: true, value: value as unknown as A2UIClientMessage };
}
