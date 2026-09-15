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
      `cannot bind a text part: ${unboundPorts.length} required ports are unset (${unboundPorts.join(", ")})`
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

function requiredPorts(schema: DataPortSchemaObject | undefined): readonly string[] {
  const required = schema?.required;
  return Array.isArray(required) ? (required as readonly string[]) : [];
}

/**
 * Inbound: an ordered list of parts, onto named ports.
 *
 * A data part states its own port names, so it binds directly. Text does not,
 * and is bound only when the schema leaves exactly one required port for it to
 * mean — with two, guessing is how a caller's argument lands silently on the
 * wrong port, and the caller has a data part available to say which.
 *
 * `raw` and `url` parts are carried by the protocol and bound to nothing: a
 * file has no port name to land on until a skill declares one.
 */
export function partsToPorts(
  parts: readonly Part[],
  schema: DataPortSchemaObject | undefined
): Record<string, unknown> {
  const ports: Record<string, unknown> = {};
  for (const part of parts) {
    const content = part.content;
    if (content?.$case !== "data") continue;
    const value: unknown = content.value;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(ports, value as Record<string, unknown>);
    }
  }

  const text = textOfParts(parts);
  if (text.length === 0) return ports;

  const unbound = requiredPorts(schema).filter((name) => !(name in ports));
  if (unbound.length === 1) {
    ports[unbound[0]!] = text;
    return ports;
  }
  if (unbound.length === 0) return ports;
  throw new PartBindingError(unbound);
}

/** Outbound: named ports as one structured part. */
export function portsToParts(ports: Record<string, unknown>): Part[] {
  return [
    {
      content: { $case: "data", value: ports },
      metadata: undefined,
      filename: "",
      mediaType: "application/json",
    },
  ];
}
