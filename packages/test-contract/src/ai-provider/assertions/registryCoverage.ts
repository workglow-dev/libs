/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability } from "@workglow/ai";
import { getAiProviderRegistry, getGlobalModelRepository } from "@workglow/ai";
import { describe, expect } from "vitest";

import { it } from "../../creditExhaustedSkip";

import type { AiProviderConformanceOpts } from "../types";

/**
 * Capability-set conformance: every model in `opts.models` must be backed by
 * a registry entry whose `serves` superset covers the model's declared
 * `capabilities`. Each capability is also probed individually to confirm the
 * provider can dispatch the bare capability via `getRunFnFor`.
 */
export function registryCoverageBlock(opts: AiProviderConformanceOpts): void {
  describe("Registry coverage", () => {
    it(
      "resolves a run function for every capability advertised by the provider's models",
      async () => {
        const candidateModelIds = [
          opts.models.textGeneration,
          opts.models.toolCalling,
          opts.models.structured,
          opts.models.embeddings,
        ].filter((id): id is string => typeof id === "string");
        expect(
          candidateModelIds.length,
          "registryCoverageBlock requires at least one model id in opts.models"
        ).toBeGreaterThan(0);

        const registry = getAiProviderRegistry();
        const repo = getGlobalModelRepository();

        const seenProviders = new Set<string>();
        const seenCapabilities = new Set<string>();

        for (const modelId of candidateModelIds) {
          const model = await repo.findByName(modelId);
          expect(model, `model "${modelId}" not found in repository`).toBeDefined();
          const providerKey = model!.provider;

          const provider = registry.getProvider(providerKey);
          expect(provider, `provider "${providerKey}" not registered`).toBeDefined();

          const capabilities = (model!.capabilities ?? []) as readonly Capability[];
          expect(
            capabilities.length,
            `model "${modelId}" advertises zero capabilities`
          ).toBeGreaterThan(0);
          seenProviders.add(providerKey);

          for (const capability of capabilities) {
            seenCapabilities.add(`${providerKey}::${capability}`);
            const runFn = registry.getRunFnFor(providerKey, [capability]);
            expect(
              runFn,
              `provider "${providerKey}" advertises capability "${capability}" via model "${modelId}" but the registry has no matching run function`
            ).toBeDefined();
          }
        }

        expect(seenProviders.size, "no providers reached during coverage walk").toBeGreaterThan(0);
        expect(
          seenCapabilities.size,
          "no capabilities reached during coverage walk"
        ).toBeGreaterThan(0);
      },
      opts.timeout
    );
  });
}
