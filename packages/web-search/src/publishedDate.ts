/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A `Map`, not an object literal: the lookup key is provider text, and an
 * object's inherited keys are reachable through it — `constructor` survives the
 * lowercasing this does, so a row reading "constructor 1, 2025" would resolve
 * to `Object` and be carried into `Date.UTC` as the month.
 */
const MONTH_INDEX = new Map<string, number>([
  ["january", 0],
  ["february", 1],
  ["march", 2],
  ["april", 3],
  ["may", 4],
  ["june", 5],
  ["july", 6],
  ["august", 7],
  ["september", 8],
  ["october", 9],
  ["november", 10],
  ["december", 11],
]);

/** Anthropic `page_age` and similar: "April 30, 2025". */
const HUMAN_CALENDAR_DATE = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/;

/**
 * Normalizes a provider's publish date onto the ISO-8601 string
 * {@link SearchResult.publishedDate} promises, or `undefined` when it is not a
 * date at all.
 *
 * Several engines report a display string next to (or instead of) a timestamp —
 * "3 days ago", "April 30, 2025". A graph filtering on recency compares with
 * `new Date(...)`, and a display string that does not parse silently becomes an
 * Invalid Date, dropping or keeping every one of that provider's rows depending
 * on which way the comparison runs. An absent date says "unknown" and can be
 * handled; a string that means a date but is not one cannot.
 *
 * Calendar dates without a time are pinned to UTC midnight of that civil day.
 * `Date.parse` of a human-written date is local midnight, so serializing it
 * with `toISOString()` would shift the ISO string by the host timezone.
 */
export function toIsoPublishedDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  const human = HUMAN_CALENDAR_DATE.exec(trimmed);
  if (human) {
    const month = MONTH_INDEX.get(human[1].toLowerCase());
    if (month !== undefined) {
      return toIso(Date.UTC(Number(human[3]), month, Number(human[2])));
    }
  }

  return toIso(Date.parse(trimmed));
}

/**
 * `toISOString()` throws on a timestamp outside the representable range. No
 * input reaching here produces one today, so this is a backstop: the contract
 * is that an unusable value reports unknown rather than failing the search that
 * produced it, and a throw would break that from anywhere.
 */
function toIso(timestamp: number): string | undefined {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}
