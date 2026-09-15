/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { A2UI_BASIC_CATALOG } from "../basicCatalog";
import { A2UI_BASIC_FUNCTIONS } from "../functions";

function call(name: string, args: Record<string, unknown>): unknown {
  return A2UI_BASIC_FUNCTIONS[name]?.(args);
}

describe("A2UI_BASIC_FUNCTIONS", () => {
  it("implements every function the catalog declares, except the one that acts", () => {
    // `openUrl` is the only one that does something rather than computing
    // something, and what opening means is the host's decision.
    const declared = A2UI_BASIC_CATALOG.functions.filter((name) => name !== "openUrl");
    const implemented = Object.keys(A2UI_BASIC_FUNCTIONS).sort();
    expect(implemented).toEqual([...declared].sort());
  });

  it("registers no function the catalog does not declare", () => {
    for (const name of Object.keys(A2UI_BASIC_FUNCTIONS)) {
      expect(A2UI_BASIC_CATALOG.functions).toContain(name);
    }
  });

  it("required treats blank strings and empty lists as missing", () => {
    expect(call("required", { value: "x" })).toBe(true);
    expect(call("required", { value: "  " })).toBe(false);
    expect(call("required", { value: [] })).toBe(false);
    expect(call("required", { value: undefined })).toBe(false);
    expect(call("required", { value: false })).toBe(true);
  });

  it("regex fails a malformed pattern rather than throwing out of the render", () => {
    // The pattern is text the agent wrote, so a bad one is ordinary input.
    expect(call("regex", { pattern: "^a+$", value: "aaa" })).toBe(true);
    expect(call("regex", { pattern: "[", value: "aaa" })).toBe(false);
  });

  it("length bounds a string at either end", () => {
    expect(call("length", { value: "abc", min: 2, max: 4 })).toBe(true);
    expect(call("length", { value: "a", min: 2 })).toBe(false);
    expect(call("length", { value: "abcde", max: 4 })).toBe(false);
  });

  it("numeric and email check what they say", () => {
    expect(call("numeric", { value: "42" })).toBe(true);
    expect(call("numeric", { value: "4x" })).toBe(false);
    expect(call("email", { value: "a@b.co" })).toBe(true);
    expect(call("email", { value: "a@b" })).toBe(false);
    expect(call("email", { value: "a@@b.co" })).toBe(false);
    expect(call("email", { value: "@b.co" })).toBe(false);
    expect(call("email", { value: "a@b.co." })).toBe(false);
    expect(call("email", { value: "a b@c.co" })).toBe(false);
  });

  it("checks an email in linear time on the shape that backtracks", () => {
    // `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` is quadratic on this input: `.` is also
    // matched by `[^\s@]`, so the two runs can split the tail O(n) ways, and
    // the trailing `@` makes every one of them fail. Measured at 2.1s for this
    // length before the check became index arithmetic. The value is whatever a
    // person typed into a field an agent drew, so it is uncontrolled input on
    // the renderer's own thread.
    const hostile = `a@${"a.".repeat(40_000)}@`;
    const started = performance.now();
    expect(call("email", { value: hostile })).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("refuses to run an agent's pattern against an unbounded subject", () => {
    // A catastrophic pattern is the agent's to write, and in a browser there is
    // no budget that can interrupt one. Bounding the subject is what keeps the
    // accidental polynomial case finishing.
    expect(call("regex", { pattern: "^(a+)+$", value: "a".repeat(100_000) })).toBe(false);
    expect(call("regex", { pattern: "^a+$", value: "aaa" })).toBe(true);
  });

  it("formatString fills named placeholders and leaves unknown ones alone", () => {
    expect(call("formatString", { template: "Hi {name}", values: { name: "Ada" } })).toBe("Hi Ada");
    expect(call("formatString", { template: "Hi {name}", values: {} })).toBe("Hi {name}");
  });

  it("formatCurrency falls back to a plain number on an unknown currency", () => {
    expect(String(call("formatCurrency", { value: 12.5, currency: "USD" }))).toContain("12.50");
    expect(String(call("formatCurrency", { value: 12.5, currency: "NOTACODE" }))).toContain("12.5");
  });

  it("formatDate answers empty for something that is not a date", () => {
    expect(call("formatDate", { value: "not a date" })).toBe("");
    expect(String(call("formatDate", { value: "2026-09-15T00:00:00.000Z" }))).not.toBe("");
  });

  it("never renders an object as [object Object]", () => {
    // A binding lands on a container when the agent points a label at one, and
    // the stringification artefact says nothing to anybody.
    const rendered = String(call("formatString", { template: "{v}", values: { v: { a: 1 } } }));
    expect(rendered).not.toContain("[object Object]");
    expect(rendered).toBe('{"a":1}');
    expect(call("pluralize", { count: 2, one: {}, other: [1, 2] })).toBe("[1,2]");
  });

  it("pluralize picks by count", () => {
    expect(call("pluralize", { count: 1, one: "item", other: "items" })).toBe("item");
    expect(call("pluralize", { count: 2, one: "item", other: "items" })).toBe("items");
  });

  it("and, or and not accept both the pair and the list spelling", () => {
    expect(call("and", { a: true, b: true })).toBe(true);
    expect(call("and", { values: [true, false] })).toBe(false);
    expect(call("or", { a: false, b: true })).toBe(true);
    expect(call("or", { values: [false, false] })).toBe(false);
    expect(call("not", { value: false })).toBe(true);
  });
});

describe("input an agent controls, reaching a runtime that throws on it", () => {
  it("clamps a fraction-digit count Intl would reject", () => {
    // A RangeError here escapes resolution and takes the render with it.
    expect(() => call("formatNumber", { value: 1.5, decimals: 101 })).not.toThrow();
    expect(() => call("formatNumber", { value: 1.5, decimals: -5 })).not.toThrow();
    expect(call("formatNumber", { value: 1.23456, decimals: 2 })).toBe("1.23");
  });

  it("refuses a pattern shaped like a catastrophic one", () => {
    // A subject cap is not a time bound: `^(a+)+$` is exponential on 4,096
    // characters as surely as on a million. The shape screen is a heuristic and
    // says so; it covers the recognisable cases, not a determined one.
    const started = performance.now();
    expect(call("regex", { pattern: "^(a+)+$", value: `${"a".repeat(4000)}b` })).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
    expect(call("regex", { pattern: "(a|aa)+", value: "aaaa" })).toBe(false);
  });

  it("still runs an ordinary pattern", () => {
    expect(call("regex", { pattern: "^[a-z]+$", value: "abc" })).toBe(true);
    expect(call("regex", { pattern: "^\\d{3}$", value: "123" })).toBe(true);
  });
});
