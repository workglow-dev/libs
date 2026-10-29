/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lightweight entry point for worker contexts.
 *
 * Exports only the provider infrastructure, message conversion utilities,
 * and model schemas needed by AI provider workers — without the 50+ task
 * class definitions that bloat the main barrel export.
 *
 * AI provider packages should import from `@workglow/ai/worker` in files
 * that run inside Web Workers / worker threads.
 */

// organize-imports-ignore

export * from "./provider/AiProvider";
export * from "./provider/AiProviderRegistry";
export * from "./provider/CheckpointRegistry";

export * from "./task/ToolCallingUtils";
export * from "./task/MessageConversion";

export * from "./model/ModelSchema";
export * from "./model/ModelPricing";
export * from "./model/ModelProfile";

// Capability vocabulary — needed by provider subclasses overriding
// `inferCapabilities` and `workerRunFnSpecs` from the worker barrel.
export * from "./capability/Capabilities";
