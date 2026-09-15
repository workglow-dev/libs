/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe } from "vitest";

import { capabilityHonestyBlock } from "./assertions/capabilityHonesty";
import { disposeBlock } from "./assertions/dispose";
import { registryCoverageBlock } from "./assertions/registryCoverage";
import { sessionReuseBlock } from "./assertions/sessionReuse";
import { signalHonoringBlock } from "./assertions/signalHonoring";
import { structuredGenerationBlock } from "./assertions/structuredGeneration";
import { textGenerationSmokeBlock } from "./assertions/textGenerationSmoke";
import { toolCallAccumulatorBlock } from "./assertions/toolCallAccumulator";
import { toolCallMultiTurnBlock } from "./assertions/toolCallMultiTurn";
import { resolveFixture } from "./fixtures";
import type { AiProviderConformanceOpts, ConformanceHandle } from "./types";

export function runAiProviderConformance(opts: AiProviderConformanceOpts): void {
  // Capability invariants: a positive capability claim must be backed by a
  // model the conformance suite can exercise. Without these, a true capability
  // would silently pass when no model is wired up, defeating the whole point
  // of capabilityHonestyBlock's positive assertions.
  const requiredModels: ReadonlyArray<readonly [boolean, string, string]> = [
    [opts.capabilities.streaming, "streaming", "textGeneration"],
    [opts.capabilities.tools, "tools", "toolCalling"],
    [opts.capabilities.structured, "structured", "structured"],
    [opts.capabilities.embeddings, "embeddings", "embeddings"],
  ];
  for (const [claimed, capabilityKey, modelKey] of requiredModels) {
    if (claimed && !opts.models[modelKey as keyof typeof opts.models]) {
      throw new Error(
        `AiProvider conformance "${opts.name}": capabilities.${capabilityKey} is true but models.${modelKey} is not set. ` +
          `Either provide a model id or set capabilities.${capabilityKey} to false.`
      );
    }
  }

  describe.skipIf(opts.skip)(`AiProvider conformance: ${opts.name}`, () => {
    let handle: ConformanceHandle | undefined;
    const getHandle = (): ConformanceHandle => {
      if (!handle) throw new Error("conformance handle not initialized");
      return handle;
    };

    beforeAll(async () => {
      handle = await opts.factory();
      await handle.register();
    }, opts.timeout);

    afterAll(async () => {
      if (handle) await handle.dispose();
    });

    const fixture = resolveFixture(opts.fixture);

    registryCoverageBlock(opts);
    textGenerationSmokeBlock(opts, fixture);
    signalHonoringBlock(opts, fixture);
    toolCallAccumulatorBlock(opts, fixture);
    toolCallMultiTurnBlock(opts, fixture);
    structuredGenerationBlock(opts, fixture);
    sessionReuseBlock(opts, fixture, getHandle);
    capabilityHonestyBlock(opts);
    // dispose runs last; it calls handle.dispose() which must be idempotent.
    disposeBlock(opts, getHandle);
  });
}
