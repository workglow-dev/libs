/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability } from "@workglow/ai";
import { accumulatingEmit, getAiProviderRegistry, getGlobalModelRepository } from "@workglow/ai";
import type { StreamEvent, TaskOutput } from "@workglow/task-graph";
import { describe, expect } from "vitest";

import { it } from "../../creditExhaustedSkip";
import { itExpectFail } from "../../itExpectFail";
import type { AiProviderConformanceOpts, ConformanceFixture } from "../types";

const TEXT_GENERATION: readonly Capability[] = ["text.generation"];

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  return e.name === "AbortError" || /abort/i.test(e.message ?? "");
}

export function signalHonoringBlock(
  opts: AiProviderConformanceOpts,
  fixture: ConformanceFixture
): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itNonStreaming = expectFails.has("signal.nonStreaming") ? itExpectFail : it;
  const skipMid = !opts.capabilities.abortMidStream;
  const itMidStream = expectFails.has("signal.midStream") ? itExpectFail : it;

  describe.skipIf(!opts.models.textGeneration)("Signal honoring", () => {
    itNonStreaming(
      "run-fn rejects with AbortError when aborted before invocation",
      async () => {
        const registry = getAiProviderRegistry();
        const repo = getGlobalModelRepository();
        const model = await repo.findByName(opts.models.textGeneration!);
        expect(model).toBeDefined();
        const runFn = registry.getRunFnFor(model!.provider, TEXT_GENERATION);
        expect(
          runFn,
          `provider "${model!.provider}" has no run-fn for ["text.generation"]`
        ).toBeDefined();
        const ac = new AbortController();
        ac.abort();

        let caught: unknown;
        try {
          const { emit } = accumulatingEmit<TaskOutput>();
          await runFn!(
            { prompt: fixture.textPrompt, maxTokens: fixture.maxTokens },
            model!,
            ac.signal,
            emit,
            undefined,
            undefined
          );
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeDefined();
        expect(isAbortError(caught)).toBe(true);
      },
      opts.timeout
    );

    if (!skipMid) {
      itMidStream(
        "streaming run-fn terminates within abortGraceMs * 4 when aborted mid-stream",
        async () => {
          const registry = getAiProviderRegistry();
          const repo = getGlobalModelRepository();
          const model = await repo.findByName(opts.models.textGeneration!);
          expect(model).toBeDefined();
          const streamFn = registry.getRunFnFor(model!.provider, TEXT_GENERATION);
          if (!streamFn) return; // capability mismatch — covered by capabilityHonesty
          const ac = new AbortController();
          const start = Date.now();
          setTimeout(() => ac.abort(), fixture.abortGraceMs);

          try {
            const emit = (_e: StreamEvent<TaskOutput>): void => {};
            await streamFn(
              { prompt: fixture.textPrompt, maxTokens: fixture.maxTokens },
              model!,
              ac.signal,
              emit,
              undefined,
              undefined
            );
          } catch (err) {
            if (!isAbortError(err)) throw err;
          }
          const elapsed = Date.now() - start;
          expect(elapsed).toBeLessThan(fixture.abortGraceMs * 4 + 2000);
        },
        opts.timeout
      );
    }
  });
}
