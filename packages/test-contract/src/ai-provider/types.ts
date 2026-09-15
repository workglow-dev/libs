/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JsonSchema } from "@workglow/util/schema";

export interface AiProviderConformanceOpts {
  readonly name: string;
  readonly skip?: boolean;
  readonly timeout: number;
  readonly factory: () => Promise<ConformanceHandle>;
  readonly capabilities: AiProviderCapabilities;
  readonly models: AiProviderConformanceModels;
  readonly fixture?: Partial<ConformanceFixture>;
  /**
   * Names of conformance assertions that are currently broken in this
   * adapter. Each named assertion is wrapped in `it.fails` instead of `it`.
   * Remove the entry once the adapter bug is fixed.
   *
   * Known names:
   *   "signal.nonStreaming"
   *   "signal.midStream"
   *   "session.reuse"
   */
  readonly expectedFailures?: ReadonlyArray<string>;
}

export interface ConformanceHandle {
  readonly register: () => Promise<void>;
  readonly dispose: () => Promise<void>;
  readonly inspect: () => ProviderInspectionHandle;
  /**
   * Optional hook the conformance harness calls before the session-reuse
   * block to release transient state (e.g. cached chat sessions) that prior
   * blocks may have accumulated. Implementations must NOT tear down models
   * or contexts — only short-lived per-call resources.
   */
  readonly releaseTransients?: () => Promise<void>;
}

export interface AiProviderCapabilities {
  readonly streaming: boolean;
  readonly tools: boolean;
  readonly structured: boolean;
  readonly embeddings: boolean;
  readonly sessions: boolean;
  readonly abortMidStream: boolean;
}

export interface AiProviderConformanceModels {
  readonly textGeneration?: string;
  readonly toolCalling?: string;
  readonly structured?: string;
  readonly embeddings?: string;
}

export interface ProviderInspectionHandle {
  readonly sessionMap?: ReadonlyMap<string, unknown>;
  readonly disposables?: ReadonlyArray<{ readonly alive: boolean }>;
}

export interface ConformanceFixture {
  readonly textPrompt: string;
  readonly weatherTool: {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonSchema;
  };
  readonly weatherToolPrompt: string;
  readonly multiTurnTranscript: ReadonlyArray<{
    readonly role: "user" | "assistant" | "tool";
    readonly text: string;
  }>;
  readonly structuredSchema: JsonSchema;
  readonly structuredPrompt: string;
  readonly maxTokens: number;
  readonly abortGraceMs: number;
}
