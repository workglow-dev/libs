/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserContextFixture } from "./types";

// Empty-name buttons are excluded — clickByRole(role, name) requires a
// non-empty accessible name on every adapter, and adapters treat an empty
// accessible name as absent. Use "a" (single char) as the lower-bound stress.
const ARIA_EDGE_CASE_NAMES: ReadonlyArray<string> = [
  "Sign in", // baseline ASCII
  "foo:bar", // colon mid-name
  "11:30", // ends in colon-digits (lastIndexOf parser)
  "a", // single character
  "héllo→", // unicode + arrow
  "x".repeat(200), // long
];

const NETWORK_MARKER = "fixture-network-marker";
const CONSOLE_MARKER = "fixture-console-marker";

function escapeForHtmlAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildPageHtml(): string {
  const buttons = ARIA_EDGE_CASE_NAMES.map(
    (name, idx) =>
      `<button type="button" aria-label="${escapeForHtmlAttr(name)}" ` +
      `onclick="document.getElementById('sentinel').setAttribute('data-clicked', '${idx}')">` +
      escapeForHtmlAttr(name) +
      `</button>`
  ).join("");
  const head = '<head><meta charset="utf-8"><title>IBrowserContext Conformance</title></head>';
  const body =
    `<body>` +
    `<div id="sentinel" data-clicked=""></div>` +
    buttons +
    `<script>` +
    `console.log(${JSON.stringify(CONSOLE_MARKER)});` +
    // Use a benign network target — data: URL keeps the page self-contained.
    `fetch("data:text/plain,${NETWORK_MARKER}").catch(function(){});` +
    `</script>` +
    `</body>`;
  return `<!DOCTYPE html><html>${head}${body}</html>`;
}

const PAGE_URL = `data:text/html,${encodeURIComponent(buildPageHtml())}`;

export const DEFAULT_FIXTURE: BrowserContextFixture = {
  pageUrl: PAGE_URL,
  networkMarkerUrl: NETWORK_MARKER,
  consoleMarker: CONSOLE_MARKER,
  ariaEdgeCaseNames: ARIA_EDGE_CASE_NAMES,
};

export function resolveFixture(
  override: Partial<BrowserContextFixture> | undefined
): BrowserContextFixture {
  if (!override) return DEFAULT_FIXTURE;
  return { ...DEFAULT_FIXTURE, ...override };
}
