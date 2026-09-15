/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { A2UIFunctions } from "../protocol/binding";

/**
 * A value as text a person reads.
 *
 * An object never reaches a label as `[object Object]`. These functions format
 * data an agent bound into a surface, so an object arriving where text was
 * expected is the agent's mistake — and showing it the data is more use than
 * showing everyone a stringification artefact.
 */
function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
}

function num(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function truthy(value: unknown): boolean {
  return Boolean(value);
}

function list(args: Record<string, unknown>): readonly unknown[] {
  const values = args.values;
  if (Array.isArray(values)) return values;
  // The catalog's boolean combinators take their operands as `a`/`b` in the
  // common case and a `values` list when there are more; accepting both keeps
  // an agent from having to know which spelling this host implemented.
  return [args.a, args.b].filter((value) => value !== undefined);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The basic catalog's client-side functions, in the forms that are pure.
 *
 * `openUrl` is deliberately absent. It is the one function in the catalog that
 * does something rather than computing something, and what "opening a URL"
 * means — a new tab, the shell, a blocked navigation — is a decision only the
 * host embedding the surface can make. A host that wants it registers its own
 * on top of these, and the URL it receives has been through the catalog's
 * scheme check on the way in.
 *
 * Locale is likewise the host's: these use the runtime's default, and a host
 * with a user preference passes its own `formatDate` and friends.
 */
export const A2UI_BASIC_FUNCTIONS: A2UIFunctions = Object.freeze({
  required: (args) => {
    const value = args.value;
    if (value === null || value === undefined) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  },
  regex: (args) => {
    const pattern = str(args.pattern);
    if (pattern.length === 0) return true;
    try {
      return new RegExp(pattern).test(str(args.value));
    } catch {
      // A pattern the agent wrote is model-controlled text, so a malformed one
      // is ordinary input rather than a fault: it fails the check it was asked
      // to perform instead of throwing out of the render.
      return false;
    }
  },
  length: (args) => {
    const value = str(args.value).length;
    const min = args.min === undefined ? undefined : num(args.min);
    const max = args.max === undefined ? undefined : num(args.max);
    if (min !== undefined && value < min) return false;
    if (max !== undefined && value > max) return false;
    return true;
  },
  numeric: (args) => Number.isFinite(num(args.value)),
  email: (args) => EMAIL.test(str(args.value)),
  formatString: (args) => {
    const template = str(args.template ?? args.format);
    const values = args.values;
    const bag =
      typeof values === "object" && values !== null ? (values as Record<string, unknown>) : args;
    return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
      key in bag ? str(bag[key]) : whole
    );
  },
  formatNumber: (args) => {
    const value = num(args.value);
    if (!Number.isFinite(value)) return "";
    const digits = args.decimals === undefined ? undefined : num(args.decimals);
    return new Intl.NumberFormat(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  },
  formatCurrency: (args) => {
    const value = num(args.value);
    if (!Number.isFinite(value)) return "";
    const currency = str(args.currency ?? "USD") || "USD";
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
    } catch {
      // An unknown currency code throws out of Intl; the number is still worth
      // showing.
      return new Intl.NumberFormat().format(value);
    }
  },
  formatDate: (args) => {
    const raw = args.value;
    const date = raw instanceof Date ? raw : new Date(str(raw));
    if (Number.isNaN(date.getTime())) return "";
    const style = str(args.style ?? "medium");
    const dateStyle = (["full", "long", "medium", "short"] as const).find((s) => s === style);
    return new Intl.DateTimeFormat(undefined, { dateStyle: dateStyle ?? "medium" }).format(date);
  },
  pluralize: (args) => {
    const count = num(args.count);
    const one = str(args.one ?? args.singular);
    const other = str(args.other ?? args.plural);
    return count === 1 ? one : other;
  },
  and: (args) => list(args).every(truthy),
  or: (args) => list(args).some(truthy),
  not: (args) => !truthy(args.value ?? args.a),
});
