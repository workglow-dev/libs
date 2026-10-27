/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelRecord } from "@workglow/ai/worker";
import {
  CONSERVATIVE_PROBED_CAPABILITIES,
  probeWebBrowserCapabilities,
  type WebBrowserProbeFactory,
  type WebBrowserProbedCapabilities,
} from "./WebBrowser_CapabilityProbe";
import { WEB_BROWSER_CAPABILITY_SETS } from "./WebBrowser_CapabilitySets";
import {
  resolveWebBrowserProfile,
  WEB_BROWSER_UNRECOGNIZED_CAPABILITIES,
  webBrowserModelName,
  webBrowserProfileCapabilities,
} from "./WebBrowser_ModelProfiles";

export const WEB_BROWSER_RUN_FN_SPECS = WEB_BROWSER_CAPABILITY_SETS.map((serves) => ({ serves }));

export function webBrowserWorkerRunFnSpecs(): readonly {
  readonly serves: readonly Capability[];
}[] {
  return WEB_BROWSER_RUN_FN_SPECS;
}

type CapabilityHints = Pick<ModelRecord, "model_id" | "provider_config" | "capabilities">;

/**
 * Capability inference for a Chrome Built-in AI {@link ModelRecord}.
 *
 * Chrome's Built-in AI exposes a fixed set of feature APIs identified by
 * model_id (e.g. `chrome-prompt`, `chrome-summarizer`, `chrome-rewriter`,
 * `chrome-translator`, `chrome-language-detector`). Declared capabilities
 * win; otherwise the model's profile (see `WEB_BROWSER_MODEL_FAMILIES`) names
 * the API, the same one `resolveWebBrowserApi` binds for download.
 *
 * `json-mode` and `tool-use` are conditional on browser support — pass a
 * known {@link WebBrowserProbedCapabilities} result via `probed` to gate
 * them. Defaults to `{jsonMode: true, toolUse: true}` for back-compat with
 * callers that haven't adopted the probe yet; new callers should pass
 * either the probe result or `CONSERVATIVE_PROBED_CAPABILITIES`.
 *
 * For an async variant that drives the probe automatically see
 * {@link inferWebBrowserCapabilitiesAsync}.
 */
export function inferWebBrowserCapabilities(
  model: CapabilityHints,
  probed: WebBrowserProbedCapabilities = { jsonMode: true, toolUse: true }
): readonly Capability[] {
  const declared = (model.capabilities as readonly Capability[] | undefined) ?? [];
  if (declared.length > 0) return declared;

  const { profile, recognized } = resolveWebBrowserProfile(webBrowserModelName(model));
  if (!recognized) return WEB_BROWSER_UNRECOGNIZED_CAPABILITIES;
  return webBrowserProfileCapabilities(profile, probed);
}

/**
 * Probe-driven variant of {@link inferWebBrowserCapabilities}. Resolves the
 * probed capability set (cached) before returning, so the result reflects
 * the real browser surface rather than assuming both `json-mode` and
 * `tool-use` are present.
 */
export async function inferWebBrowserCapabilitiesAsync(
  model: CapabilityHints,
  factory?: WebBrowserProbeFactory
): Promise<readonly Capability[]> {
  const probed = await probeWebBrowserCapabilities(factory);
  return inferWebBrowserCapabilities(model, probed);
}

export { CONSERVATIVE_PROBED_CAPABILITIES };
