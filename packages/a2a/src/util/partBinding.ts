/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from "@a2a-js/sdk";
import type { DataPortSchemaObject } from "@workglow/util/schema";

/** A text part that could not be bound, and the ports that were left unset. */
export class PartBindingError extends Error {
  public readonly unboundPorts: readonly string[];

  constructor(unboundPorts: readonly string[]) {
    super(
      unboundPorts.length === 0
        ? "cannot bind a text part: every port it could mean is already set"
        : `cannot bind a text part: ${unboundPorts.length} ports could take it (${unboundPorts.join(", ")})`
    );
    this.name = "PartBindingError";
    this.unboundPorts = unboundPorts;
  }
}

/** A text part the SDK will accept, media type and all. */
export function textPart(value: string): Part {
  return {
    content: { $case: "text", value },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

/** Every text part, in order. Several is normal; taking only the first drops input. */
export function textOfParts(parts: readonly Part[]): string {
  return parts.map((part) => (part.content?.$case === "text" ? part.content.value : "")).join("");
}

/**
 * Keys a caller may never set through a data part. They are not ports on any
 * schema, and assigning `__proto__` swaps the port bag's prototype rather than
 * landing as a property.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function requiredPorts(schema: DataPortSchemaObject | undefined): readonly string[] {
  const required = schema?.required;
  return Array.isArray(required) ? (required as readonly string[]) : [];
}

function declaredPorts(schema: DataPortSchemaObject | undefined): readonly string[] | undefined {
  const properties = schema?.properties;
  return properties && typeof properties === "object" ? Object.keys(properties) : undefined;
}

function isStringPort(schema: DataPortSchemaObject | undefined, name: string): boolean {
  const property = (schema?.properties as Record<string, unknown> | undefined)?.[name];
  return (
    typeof property === "object" &&
    property !== null &&
    (property as { type?: unknown }).type === "string"
  );
}

/**
 * Inbound: an ordered list of parts, onto named ports.
 *
 * A data part states its own port names, so it binds directly — but only the
 * names the schema declares. A peer's keys are the caller's to choose, and a
 * key the skill never declared is not a port: it is whatever the host merges
 * this bag into, which is exactly what an opaque peer must not reach.
 *
 * Text names no port, and is bound only when exactly one port can take it:
 * a required port still unset, or failing that a declared string port still
 * unset. With two, guessing is how a caller's argument lands silently on the
 * wrong port, and with none, dropping the text is how a caller's whole
 * message vanishes — so both refuse, naming the ports involved.
 *
 * `raw` and `url` parts are carried by the protocol and bound to nothing: a
 * file has no port name to land on until a skill declares one.
 */
export function partsToPorts(
  parts: readonly Part[],
  schema: DataPortSchemaObject | undefined
): Record<string, unknown> {
  const declared = declaredPorts(schema);
  const ports: Record<string, unknown> = {};
  for (const part of parts) {
    const content = part.content;
    if (content?.$case !== "data") continue;
    const value: unknown = content.value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    for (const key of Object.keys(value)) {
      if (RESERVED_KEYS.has(key)) continue;
      if (declared !== undefined && !declared.includes(key)) continue;
      ports[key] = (value as Record<string, unknown>)[key];
    }
  }

  const text = textOfParts(parts);
  if (text.length === 0) return ports;

  const unset = (name: string): boolean => !(name in ports);
  let candidates = requiredPorts(schema).filter(unset);
  if (candidates.length === 0) {
    candidates = (declared ?? []).filter((name) => unset(name) && isStringPort(schema, name));
  }
  if (candidates.length !== 1) throw new PartBindingError(candidates);
  ports[candidates[0]!] = text;
  return ports;
}
