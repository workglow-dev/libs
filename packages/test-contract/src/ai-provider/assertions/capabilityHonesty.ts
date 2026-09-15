/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability } from "@workglow/ai";
import { getAiProviderRegistry, getGlobalModelRepository, textEmbedding } from "@workglow/ai";
import { describe, expect } from "vitest";

import { it } from "../../creditExhaustedSkip";

import type { AiProviderConformanceOpts } from "../types";

const TEXT_GENERATION: readonly Capability[] = ["text.generation"];
const TOOL_USE: readonly Capability[] = ["text.generation", "tool-use"];
const STRUCTURED: readonly Capability[] = ["text.generation", "json-mode"];
const TEXT_EMBEDDING: readonly Capability[] = ["text.embedding"];

export function capabilityHonestyBlock(opts: AiProviderConformanceOpts): void {
  describe("Capability honesty", () => {
    // ------------------------------------------------------------------
    // Negative direction: declared false → no run/stream function exists.
    // ------------------------------------------------------------------

    it.skipIf(opts.capabilities.streaming || !opts.models.textGeneration)(
      "declares streaming=false → registry has no stream function",
      async () => {
        const registry = getAiProviderRegistry();
        const model = await getGlobalModelRepository().findByName(opts.models.textGeneration!);
        expect(model).toBeDefined();
        const fn = registry.getRunFnFor(model!.provider, TEXT_GENERATION);
        expect(fn).toBeUndefined();
      },
      opts.timeout
    );

    it.skipIf(opts.capabilities.tools || !opts.models.textGeneration)(
      "declares tools=false → registry rejects ToolCallingTask lookup",
      async () => {
        const registry = getAiProviderRegistry();
        const model = await getGlobalModelRepository().findByName(opts.models.textGeneration!);
        expect(model).toBeDefined();
        const fn = registry.getRunFnFor(model!.provider, TOOL_USE);
        expect(fn).toBeUndefined();
      },
      opts.timeout
    );

    it.skipIf(opts.capabilities.embeddings || !opts.models.textGeneration)(
      "declares embeddings=false → registry rejects TextEmbeddingTask lookup",
      async () => {
        const registry = getAiProviderRegistry();
        const model = await getGlobalModelRepository().findByName(opts.models.textGeneration!);
        expect(model).toBeDefined();
        const fn = registry.getRunFnFor(model!.provider, TEXT_EMBEDDING);
        expect(fn).toBeUndefined();
      },
      opts.timeout
    );

    it.skipIf(opts.capabilities.structured || !opts.models.textGeneration)(
      "declares structured=false → registry rejects StructuredGenerationTask lookup",
      async () => {
        const registry = getAiProviderRegistry();
        const model = await getGlobalModelRepository().findByName(opts.models.textGeneration!);
        expect(model).toBeDefined();
        const fn = registry.getRunFnFor(model!.provider, STRUCTURED);
        expect(fn).toBeUndefined();
      },
      opts.timeout
    );

    // ------------------------------------------------------------------
    // Positive direction: declared true → the wiring actually exists.
    // Calling a capability "supported" without testing it was the
    // original sin these blocks exist to prevent.
    // ------------------------------------------------------------------

    it.skipIf(!opts.capabilities.streaming || !opts.models.textGeneration)(
      "declares streaming=true → registry has a stream function",
      async () => {
        const registry = getAiProviderRegistry();
        const model = await getGlobalModelRepository().findByName(opts.models.textGeneration!);
        expect(model).toBeDefined();
        const fn = registry.getRunFnFor(model!.provider, TEXT_GENERATION);
        expect(fn).toBeDefined();
      },
      opts.timeout
    );

    it.skipIf(!opts.capabilities.tools || !opts.models.toolCalling)(
      "declares tools=true → registry has a ToolCallingTask run function",
      async () => {
        const registry = getAiProviderRegistry();
        const model = await getGlobalModelRepository().findByName(opts.models.toolCalling!);
        expect(model).toBeDefined();
        const fn = registry.getRunFnFor(model!.provider, TOOL_USE);
        expect(fn).toBeDefined();
      },
      opts.timeout
    );

    it.skipIf(!opts.capabilities.structured || !opts.models.structured)(
      "declares structured=true → registry has a StructuredGenerationTask run function",
      async () => {
        const registry = getAiProviderRegistry();
        const model = await getGlobalModelRepository().findByName(opts.models.structured!);
        expect(model).toBeDefined();
        const fn = registry.getRunFnFor(model!.provider, STRUCTURED);
        expect(fn).toBeDefined();
      },
      opts.timeout
    );

    it.skipIf(!opts.capabilities.embeddings || !opts.models.embeddings)(
      "declares embeddings=true → registry has a run function and produces a finite vector",
      async () => {
        const registry = getAiProviderRegistry();
        const model = await getGlobalModelRepository().findByName(opts.models.embeddings!);
        expect(model).toBeDefined();
        const fn = registry.getRunFnFor(model!.provider, TEXT_EMBEDDING);
        expect(fn).toBeDefined();

        const result = await textEmbedding({
          model: opts.models.embeddings!,
          text: "hello",
        });

        const vector = result.vector;
        // TextEmbeddingTaskOutput.vector is TypedArraySchema — accept any
        // typed-array view (Float32Array, Float64Array, etc.). DataView is
        // explicitly excluded since it's not a numeric typed array.
        const isTypedArray = ArrayBuffer.isView(vector) && !(vector instanceof DataView);
        expect(isTypedArray, "vector must be a numeric typed array").toBe(true);
        const values = Array.from(vector as ArrayLike<number>);
        expect(values.length).toBeGreaterThan(0);
        for (const v of values) {
          expect(Number.isFinite(v)).toBe(true);
        }
      },
      opts.timeout
    );
  });
}
