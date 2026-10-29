/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { PermanentJobError } from "@workglow/job-queue";
import type { WebBrowserModelConfig } from "./WebBrowser_ModelSchema";
import { resolveWebBrowserProfile, webBrowserModelName } from "./WebBrowser_ModelProfiles";

function getApi<T>(name: string, global: T | undefined): T {
  if (!global) {
    throw new PermanentJobError(
      `Chrome Built-in AI "${name}" API is not available in this browser.`
    );
  }
  return global;
}

/** Default language pair for Translator availability when the task has no langs yet. */
const DEFAULT_TRANSLATOR_LANGS = { sourceLanguage: "en", targetLanguage: "es" } as const;

/**
 * Chrome requires the same options for `availability()` as for `create()` / `prompt()`.
 * @see https://developer.chrome.com/docs/ai/prompt-api
 */
export const LANGUAGE_MODEL_AVAILABILITY_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
} as const satisfies LanguageModelCreateCoreOptions;

export type WebBrowserApiBinding =
  | {
      apiName: "Summarizer";
      factory: typeof Summarizer;
      availabilityOptions?: SummarizerCreateCoreOptions;
      createOptions?: SummarizerCreateCoreOptions;
    }
  | {
      apiName: "Rewriter";
      factory: typeof Rewriter;
      availabilityOptions?: RewriterCreateCoreOptions;
      createOptions?: RewriterCreateCoreOptions;
    }
  | {
      apiName: "Translator";
      factory: typeof Translator;
      availabilityOptions: TranslatorCreateCoreOptions;
      createOptions: TranslatorCreateCoreOptions;
    }
  | {
      apiName: "LanguageDetector";
      factory: typeof LanguageDetector;
      availabilityOptions?: LanguageDetectorCreateCoreOptions;
      createOptions?: LanguageDetectorCreateCoreOptions;
    }
  | {
      apiName: "LanguageModel";
      factory: typeof LanguageModel;
      availabilityOptions?: LanguageModelCreateCoreOptions;
      createOptions?: LanguageModelCreateCoreOptions;
    };

function languageModelFactory(): typeof LanguageModel | undefined {
  if (typeof LanguageModel !== "undefined") {
    return LanguageModel;
  }
  const ai = (globalThis as typeof globalThis & { ai?: { languageModel?: typeof LanguageModel } })
    .ai;
  return ai?.languageModel;
}

/**
 * Maps a {@link WebBrowserModelConfig} to the Chrome Built-in AI factory that owns
 * its on-device weights (Prompt / Summarizer / Translator / Rewriter / Language Detector),
 * as the model's profile names it. An id no family names binds the Prompt API.
 */
export function resolveWebBrowserApi(
  model: WebBrowserModelConfig | undefined
): WebBrowserApiBinding {
  const { api } = resolveWebBrowserProfile(webBrowserModelName(model)).profile;
  switch (api) {
    case "Summarizer":
      return {
        apiName: "Summarizer",
        factory: getApi("Summarizer", typeof Summarizer !== "undefined" ? Summarizer : undefined),
      };
    case "Rewriter":
      return {
        apiName: "Rewriter",
        factory: getApi("Rewriter", typeof Rewriter !== "undefined" ? Rewriter : undefined),
      };
    case "Translator":
      return {
        apiName: "Translator",
        factory: getApi("Translator", typeof Translator !== "undefined" ? Translator : undefined),
        availabilityOptions: { ...DEFAULT_TRANSLATOR_LANGS },
        createOptions: { ...DEFAULT_TRANSLATOR_LANGS },
      };
    case "LanguageDetector":
      return {
        apiName: "LanguageDetector",
        factory: getApi(
          "LanguageDetector",
          typeof LanguageDetector !== "undefined" ? LanguageDetector : undefined
        ),
      };
    case "LanguageModel":
      return {
        apiName: "LanguageModel",
        factory: getApi("LanguageModel", languageModelFactory()),
        availabilityOptions: { ...LANGUAGE_MODEL_AVAILABILITY_OPTIONS },
        createOptions: {},
      };
  }
}

export function isWebBrowserModelCached(availability: Availability): boolean {
  return availability === "available";
}
