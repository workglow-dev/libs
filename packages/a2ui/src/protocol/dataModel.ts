/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Keys that never reach a data model, however they are spelled on the wire.
 *
 * A surface's data model is an ordinary object that component bindings read
 * through, so assigning `__proto__` swaps its prototype rather than landing as
 * a property — and every later read of an unset path answers out of whatever
 * the agent put there. The agent writing these is model-controlled text, which
 * is the whole reason the check is here and not left to the renderer.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** A JSON pointer that named something the data model cannot hold. */
export class A2UIPointerError extends Error {
  public readonly pointer: string;

  constructor(pointer: string, detail: string) {
    super(`invalid data model pointer "${pointer}": ${detail}`);
    this.name = "A2UIPointerError";
    this.pointer = pointer;
  }
}

/**
 * Highest array index a patch may write.
 *
 * An index is also a length: writing `/items/4294967294` leaves an array
 * reporting 4,294,967,295 entries, and anything that then walks it — a repeated
 * template, most obviously — hangs the renderer over one message. The batch
 * limits bound how much an agent may SEND, and say nothing about what one small
 * message can make.
 */
const MAX_ARRAY_INDEX = 10_000;

const NUMERIC_SEGMENT = /^(?:0|[1-9][0-9]*)$/;

/**
 * The segments of a JSON pointer, unescaped.
 *
 * `/` and the empty string both mean the root. Anything not starting with `/`
 * is refused rather than treated as a single segment: a relative-looking path
 * is how a write meant for `/user/name` lands at the root as `"user/name"`.
 */
export function parsePointer(pointer: string): readonly string[] {
  if (pointer === "" || pointer === "/") return [];
  if (!pointer.startsWith("/")) {
    throw new A2UIPointerError(pointer, "a pointer must start with /");
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => {
      const unescaped = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      if (RESERVED_KEYS.has(unescaped)) {
        throw new A2UIPointerError(pointer, `"${unescaped}" is not a writable key`);
      }
      // Refused here rather than where the write lands, so the one caller with
      // somewhere to report it — the batch validator — sees it before any fold
      // does. A throw out of a fold reaches a task as an opaque failure and a
      // renderer in the middle of drawing.
      if (NUMERIC_SEGMENT.test(unescaped) && Number(unescaped) > MAX_ARRAY_INDEX) {
        throw new A2UIPointerError(pointer, `index ${unescaped} is beyond ${MAX_ARRAY_INDEX}`);
      }
      return unescaped;
    });
}

function isIndex(segment: string): boolean {
  return NUMERIC_SEGMENT.test(segment);
}

function emptyContainerFor(segment: string): Record<string, unknown> | unknown[] {
  return isIndex(segment) ? [] : {};
}

/**
 * Strips reserved keys from a value about to enter the data model.
 *
 * Structured-clone-style copy rather than an in-place delete: the value arrives
 * parsed from the agent's JSON and may be shared with the message the caller
 * keeps, so mutating it would edit what a transcript later replays.
 */
function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (RESERVED_KEYS.has(key)) continue;
    out[key] = sanitize(entry);
  }
  return out;
}

/**
 * Applies one `updateDataModel` to a data model, returning the new one.
 *
 * `value` absent removes what sits at `path`; the protocol distinguishes that
 * from writing `null`, and a renderer's bindings read the two differently — an
 * absent path falls through to whatever a parent template supplies, a null one
 * does not.
 *
 * Missing containers along the way are created, taking their kind from the next
 * segment: a numeric segment makes an array, anything else an object. Without
 * that, the protocol's own incremental idiom — `updateDataModel` at
 * `/restaurants/3` before anything has written `/restaurants` — drops the write.
 */
export function applyDataModelPatch(
  model: Readonly<Record<string, unknown>>,
  path: string | undefined,
  value: unknown,
  hasValue: boolean
): Record<string, unknown> {
  const segments = parsePointer(path ?? "/");
  if (segments.length === 0) {
    if (!hasValue) return {};
    const root = sanitize(value);
    if (typeof root !== "object" || root === null || Array.isArray(root)) {
      throw new A2UIPointerError(path ?? "/", "the root of a data model must be an object");
    }
    return root as Record<string, unknown>;
  }

  type Container = Record<string, unknown> | unknown[];

  const readAt = (container: Container, segment: string): unknown =>
    Array.isArray(container)
      ? container[Number(segment)]
      : (container as Record<string, unknown>)[segment];

  const writeAt = (container: Container, segment: string, entry: unknown): void => {
    if (Array.isArray(container)) {
      if (!isIndex(segment)) {
        throw new A2UIPointerError(path ?? "/", `"${segment}" is not an array index`);
      }
      container[Number(segment)] = entry;
      return;
    }
    (container as Record<string, unknown>)[segment] = entry;
  };

  // A delete only removes, so it must not build the path it walks: creating
  // `{ user: {} }` on the way to removing `/user/name` turns a binding on
  // `/user` from undefined into an object, which is a write nobody asked for.
  if (!hasValue) {
    let probe: unknown = model;
    for (const segment of segments.slice(0, -1)) {
      if (typeof probe !== "object" || probe === null) return { ...model };
      probe = Array.isArray(probe)
        ? probe[Number(segment)]
        : (probe as Record<string, unknown>)[segment];
    }
    if (typeof probe !== "object" || probe === null) return { ...model };
  }

  const next: Record<string, unknown> = { ...model };
  let cursor: Container = next;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    const child: unknown = readAt(cursor, segment);
    const container: Container = Array.isArray(child)
      ? [...child]
      : typeof child === "object" && child !== null
        ? { ...(child as Record<string, unknown>) }
        : emptyContainerFor(segments[i + 1]!);
    writeAt(cursor, segment, container);
    cursor = container;
  }

  const last = segments[segments.length - 1]!;
  if (Array.isArray(cursor)) {
    if (!isIndex(last)) throw new A2UIPointerError(path ?? "/", `"${last}" is not an array index`);
    if (hasValue) cursor[Number(last)] = sanitize(value);
    else cursor.splice(Number(last), 1);
  } else if (hasValue) {
    (cursor as Record<string, unknown>)[last] = sanitize(value);
  } else {
    delete (cursor as Record<string, unknown>)[last];
  }
  return next;
}
