/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelProfileFamily, ResolvedModelProfile } from "@workglow/ai/worker";
import { makeModelProfileResolver } from "@workglow/ai/worker";
import type { WebBrowserProbedCapabilities } from "./WebBrowser_CapabilityProbe";

/** The Chrome Built-in AI global that owns a model's on-device weights. */
export type WebBrowserApiName =
  | "LanguageModel"
  | "Summarizer"
  | "Rewriter"
  | "Translator"
  | "LanguageDetector";

/**
 * What differs per Chrome Built-in AI model: which browser API backs it.
 * Capability inference and the API binding (download, availability) both read
 * this one answer, so a model cannot be advertised as one API and downloaded
 * as another.
 */
export interface WebBrowserModelProfile {
  readonly api: WebBrowserApiName;
}

const LANGUAGE_MODEL: WebBrowserModelProfile = { api: "LanguageModel" };

/**
 * Ordered: the first match wins. Every Chrome API runs on Gemini Nano, so an
 * id naming a task-specific API (`gemini-nano-summarizer`) is that API; the
 * Prompt API family is matched only after them.
 */
export const WEB_BROWSER_MODEL_FAMILIES: readonly ModelProfileFamily<WebBrowserModelProfile>[] = [
  { when: /summariz/, profile: { api: "Summarizer" } },
  { when: /rewrit/, profile: { api: "Rewriter" } },
  { when: /translat/, profile: { api: "Translator" } },
  { when: /language[-_]?detect/, profile: { api: "LanguageDetector" } },
  { when: /prompt|gemini[-_]?nano/, profile: LANGUAGE_MODEL },
];

export function normalizeWebBrowserModelId(id: string): string {
  return id.trim().toLowerCase();
}

export type WebBrowserResolvedProfile = ResolvedModelProfile<WebBrowserModelProfile>;

/**
 * An id no family names still needs an API to bind for download and status,
 * so it is the Prompt API — but unrecognized, so capability inference
 * advertises only the meta-ops for it.
 */
export const resolveWebBrowserProfile: (
  modelName: string | undefined
) => WebBrowserResolvedProfile = makeModelProfileResolver<WebBrowserModelProfile>({
  families: WEB_BROWSER_MODEL_FAMILIES,
  normalize: normalizeWebBrowserModelId,
  fallback: LANGUAGE_MODEL,
});

/**
 * The fields a profile is read from. Optional, as on a model config, so both a
 * stored record and the config a run-fn receives satisfy it.
 */
interface ProfileHints {
  readonly model_id?: string | undefined;
  readonly provider_config?: unknown;
}

/** The name a Chrome AI record is profiled by: its id, else its model name. */
export function webBrowserModelName(model: ProfileHints | undefined): string {
  const config = model?.provider_config as { readonly model_name?: string | undefined } | undefined;
  return String(model?.model_id ?? config?.model_name ?? "");
}

/**
 * Capabilities the Prompt API advertises unconditionally. `json-mode` and
 * `tool-use` are gated on `probed`, because the `responseConstraint` and
 * `tools` options on `LanguageModel.create` / `prompt` are not supported on
 * every Chrome build and channel.
 */
const PROMPT_BASE_CAPABILITIES = [
  "text.generation",
  "text.rewriter",
  "text.summary",
  "model.download",
  "model.dispose",
  "model.info",
  "model.search",
] as const satisfies readonly Capability[];

/**
 * The task capabilities a profile serves. The Prompt API's optional surface
 * is a runtime input on top of the profile: what the running browser was
 * probed to support.
 */
export function webBrowserProfileCapabilities(
  profile: WebBrowserModelProfile,
  probed: WebBrowserProbedCapabilities
): readonly Capability[] {
  switch (profile.api) {
    case "LanguageModel": {
      const caps: Capability[] = [...PROMPT_BASE_CAPABILITIES];
      if (probed.jsonMode) caps.splice(1, 0, "json-mode");
      if (probed.toolUse) {
        // After json-mode when present, so the order is stable.
        caps.splice(probed.jsonMode ? 2 : 1, 0, "tool-use");
      }
      return caps;
    }
    case "Summarizer":
      return ["text.summary", "model.download", "model.info", "model.search"];
    case "Rewriter":
      return ["text.rewriter", "model.download", "model.info", "model.search"];
    case "Translator":
      return ["text.translation", "model.download", "model.info", "model.search"];
    case "LanguageDetector":
      return ["text.language-detection", "model.download", "model.info", "model.search"];
  }
}

/** What an id no family names advertises: the meta-ops alone. */
export const WEB_BROWSER_UNRECOGNIZED_CAPABILITIES: readonly Capability[] = [
  "model.download",
  "model.search",
  "model.info",
];
