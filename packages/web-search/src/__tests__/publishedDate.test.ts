/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { toIsoPublishedDate } from "../publishedDate";

describe("toIsoPublishedDate", () => {
  it("passes an ISO timestamp through as ISO", () => {
    expect(toIsoPublishedDate("2017-06-12T00:00:00Z")).toBe("2017-06-12T00:00:00.000Z");
  });

  it("normalizes a date-only value", () => {
    expect(toIsoPublishedDate("2024-11-15")).toBe("2024-11-15T00:00:00.000Z");
  });

  it("normalizes a human-written date rather than passing the display text on", () => {
    // Anthropic's page_age reads like this. It is a real date, but a caller
    // comparing `new Date(r.publishedDate)` deserves the same shape from every
    // provider.
    expect(toIsoPublishedDate("April 30, 2025")).toBe("2025-04-30T00:00:00.000Z");
  });

  it("drops a relative phrase rather than reporting it as a date", () => {
    // Brave's `age`. Left as-is it becomes an Invalid Date downstream, which
    // silently drops (or, inverted, silently keeps) every row from that
    // provider — absent says "unknown", and that a caller can handle.
    expect(toIsoPublishedDate("3 days ago")).toBeUndefined();
    expect(toIsoPublishedDate("2 weeks ago")).toBeUndefined();
  });

  it("reports an inherited object key as unknown instead of throwing", () => {
    // The month lookup lowercases, which leaves `constructor` as the one
    // inherited key a provider row can still reach. Through an object literal
    // it resolved to `Object`, `Date.UTC(2025, Object, 1)` was NaN, and
    // `toISOString()` threw a RangeError — failing the WHOLE search over one
    // bad row, which is the opposite of what this function exists to do.
    // Brave's `age`, Anthropic's `page_age`, Tavily and SearXNG all call it
    // unwrapped.
    expect(toIsoPublishedDate("constructor 1, 2025")).toBeUndefined();
    expect(toIsoPublishedDate("Constructor 1, 2025")).toBeUndefined();
    expect(toIsoPublishedDate("toString 1, 2025")).toBeUndefined();
    expect(toIsoPublishedDate("hasOwnProperty 1, 2025")).toBeUndefined();
  });

  it("treats absent and blank alike", () => {
    expect(toIsoPublishedDate(undefined)).toBeUndefined();
    expect(toIsoPublishedDate("   ")).toBeUndefined();
  });
});
