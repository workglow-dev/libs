/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conformance suite for an AI provider adapter: what it advertises it can do
 * is what it serves, over both the inline and worker registrations.
 */

export * from "./ai-provider/fixtures";
export * from "./ai-provider/runAiProviderConformance";
export * from "./ai-provider/types";
export * from "./ai-provider/assertions/capabilityHonesty";
export * from "./ai-provider/assertions/dispose";
export * from "./ai-provider/assertions/inferAdvertisesRegistered";
export * from "./ai-provider/assertions/inferServesInferred";
export * from "./ai-provider/assertions/pricingMatchesModality";
export * from "./ai-provider/assertions/registryCoverage";
export * from "./ai-provider/assertions/sessionReuse";
export * from "./ai-provider/assertions/signalHonoring";
export * from "./ai-provider/assertions/structuredGeneration";
export * from "./ai-provider/assertions/textGenerationSmoke";
export * from "./ai-provider/assertions/toolCallAccumulator";
export * from "./ai-provider/assertions/toolCallMultiTurn";
export * from "./ai-provider/assertions/usageNormalization";
