/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability } from "@workglow/ai";
import { accumulatingEmit, getAiProviderRegistry, getGlobalModelRepository } from "@workglow/ai";
import type { TaskOutput } from "@workglow/task-graph";
import { getLogger } from "@workglow/util";
import { beforeAll, describe, expect } from "vitest";

import { it } from "../../creditExhaustedSkip";
import { itExpectFail } from "../../itExpectFail";
import type { AiProviderConformanceOpts, ConformanceFixture, ConformanceHandle } from "../types";

const TEXT_GENERATION: readonly Capability[] = ["text.generation"];

export function sessionReuseBlock(
  opts: AiProviderConformanceOpts,
  fixture: ConformanceFixture,
  getHandle: () => ConformanceHandle
): void {
  const enabled = opts.capabilities.sessions && !!opts.models.textGeneration;
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itImpl = expectFails.has("session.reuse") ? itExpectFail : it;
  describe.skipIf(!enabled)("Session reuse", () => {
    beforeAll(async () => {
      await getHandle().releaseTransients?.();
    });
    itImpl(
      "two invocations with the same sessionId yield exactly one session-map entry",
      async () => {
        const handle = getHandle();
        const map = handle.inspect().sessionMap;
        if (!map) {
          getLogger().warn(
            `[conformance] ${opts.name} declares sessions=true but inspect().sessionMap is undefined; skipping`
          );
          return;
        }
        const sizeBefore = map.size;

        const registry = getAiProviderRegistry();
        const model = await getGlobalModelRepository().findByName(opts.models.textGeneration!);
        expect(model).toBeDefined();
        const runFn = registry.getRunFnFor(model!.provider, TEXT_GENERATION);
        expect(
          runFn,
          `provider "${model!.provider}" has no run-fn for ["text.generation"]`
        ).toBeDefined();

        const sessionId = `conformance-${Date.now()}`;
        {
          const { emit } = accumulatingEmit<TaskOutput>();
          await runFn!(
            { prompt: fixture.textPrompt, maxTokens: fixture.maxTokens },
            model!,
            new AbortController().signal,
            emit,
            undefined,
            { sessionId }
          );
        }
        {
          const { emit } = accumulatingEmit<TaskOutput>();
          await runFn!(
            { prompt: fixture.textPrompt, maxTokens: fixture.maxTokens },
            model!,
            new AbortController().signal,
            emit,
            undefined,
            { sessionId }
          );
        }

        const newEntries = map.size - sizeBefore;
        expect(newEntries).toBe(1);
      },
      opts.timeout
    );
  });
}
