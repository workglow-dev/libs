/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { itExpectFail } from "../../itExpectFail";
import type { WorkerProxyBoundaryOpts } from "../types";
import { streamProviderTextGeneration } from "./providerCallHelpers";

const FAIL_KEY = "boundary.backlogOrdering";

interface CollectedRun {
  readonly events: ReadonlyArray<{ readonly type: string }>;
  readonly finishCount: number;
}

async function collectStream(
  modelId: string,
  prompt: string,
  timeoutMs: number
): Promise<CollectedRun> {
  const events: Array<{ readonly type: string }> = [];
  let finishCount = 0;
  for await (const ev of streamProviderTextGeneration(modelId, prompt, {
    maxTokens: 32,
    timeoutMs,
  })) {
    const e = ev as { type: string };
    events.push({ type: e.type });
    if (e.type === "finish") finishCount += 1;
  }
  return { events, finishCount };
}

export function backlogOrderingBlock(opts: WorkerProxyBoundaryOpts): void {
  const failing = opts.expectedFailures?.includes(FAIL_KEY) ?? false;
  const test = failing ? itExpectFail : it;

  describe("PostMessage handles concurrent streams independently", () => {
    test(
      "three concurrent streams each deliver deltas before exactly one finish event",
      async () => {
        const modelId = opts.models.textGeneration;
        if (!modelId) {
          throw new Error(`${opts.name}: models.textGeneration is required for boundary tests`);
        }
        const prompts = [
          "Reply with the single word ALPHA.",
          "Reply with the single word BETA.",
          "Reply with the single word GAMMA.",
        ];
        const runs = await Promise.all(
          prompts.map((p) => collectStream(modelId, p, opts.timeout / 2))
        );

        for (const run of runs) {
          expect(run.finishCount).toBe(1);
          expect(run.events[run.events.length - 1]?.type).toBe("finish");
          const deltaTypes = run.events
            .slice(0, -1)
            .map((e) => e.type)
            .filter((t) => t.endsWith("-delta"));
          expect(deltaTypes.length).toBeGreaterThan(0);
        }
      },
      opts.timeout
    );
  });
}
