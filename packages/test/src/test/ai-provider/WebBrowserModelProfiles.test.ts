/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly as chromeAi } from "@workglow/chrome-ai/ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { describeModelProfileContract } from "./modelProfileContract";

const {
  normalizeWebBrowserModelId,
  resolveWebBrowserProfile,
  webBrowserProfileCapabilities,
  inferWebBrowserCapabilities,
  resolveWebBrowserApi,
} = chromeAi;

const BROWSER_APIS = [
  "LanguageModel",
  "Summarizer",
  "Rewriter",
  "Translator",
  "LanguageDetector",
] as const;

// The binding throws when the browser lacks an API, so every global is stood
// up as a stand-in: what is asserted is which one it picks.
beforeAll(() => {
  for (const api of BROWSER_APIS) vi.stubGlobal(api, { api });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const record = (model_id: string) => ({ model_id, provider_config: {} }) as never;

const BOTH = { jsonMode: true, toolUse: true } as const;
const NEITHER = { jsonMode: false, toolUse: false } as const;

describeModelProfileContract({
  provider: "Chrome Built-in AI",
  resolve: resolveWebBrowserProfile,
  rows: {},
  normalize: normalizeWebBrowserModelId,
  normalizes: [[" Chrome-Summarizer ", "chrome-summarizer"]],
  unlisted: [
    ["prompt-api", "family", true],
    ["chrome-prompt", "family", true],
    ["gemini-nano", "family", true],
    ["Gemini_Nano", "family", true],
    ["summarizer", "family", true],
    ["chrome-rewriter", "family", true],
    ["chrome-translator", "family", true],
    ["chrome-language-detector", "family", true],
    ["language_detector", "family", true],
    ["gemini-nano-summarizer", "family", true],
    ["webgpu", "default", false],
    ["", "default", false],
  ],
  agrees: (name, profile, recognized) => {
    expect(resolveWebBrowserApi(record(name)).apiName).toBe(profile.api);
    for (const probed of [BOTH, NEITHER]) {
      const caps = inferWebBrowserCapabilities(record(name), probed);
      if (recognized) {
        expect(caps).toEqual(webBrowserProfileCapabilities(profile, probed));
      } else {
        expect(caps).toEqual(["model.download", "model.search", "model.info"]);
      }
    }
  },
});

describe("Chrome Built-in AI profile", () => {
  it("binds the task-specific API for an id that also names Gemini Nano", () => {
    expect(resolveWebBrowserProfile("gemini-nano-summarizer").profile.api).toBe("Summarizer");
    expect(inferWebBrowserCapabilities(record("gemini-nano-summarizer"))).toEqual([
      "text.summary",
      "model.download",
      "model.info",
      "model.search",
    ]);
  });

  it("binds the Prompt API for an id it does not recognize, advertising only meta-ops", () => {
    expect(resolveWebBrowserApi(record("webgpu")).apiName).toBe("LanguageModel");
    expect(inferWebBrowserCapabilities(record("webgpu"))).toEqual([
      "model.download",
      "model.search",
      "model.info",
    ]);
  });

  it("gates the Prompt API's json-mode and tool-use on the probe", () => {
    const profile = resolveWebBrowserProfile("prompt-api").profile;
    expect(webBrowserProfileCapabilities(profile, BOTH)).toEqual([
      "text.generation",
      "json-mode",
      "tool-use",
      "text.rewriter",
      "text.summary",
      "model.download",
      "model.dispose",
      "model.info",
      "model.search",
    ]);
    expect(webBrowserProfileCapabilities(profile, { jsonMode: false, toolUse: true })).toEqual([
      "text.generation",
      "tool-use",
      "text.rewriter",
      "text.summary",
      "model.download",
      "model.dispose",
      "model.info",
      "model.search",
    ]);
    expect(webBrowserProfileCapabilities(profile, NEITHER)).not.toContain("json-mode");
  });
});
