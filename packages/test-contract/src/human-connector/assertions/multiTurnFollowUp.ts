/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IHumanRequest } from "@workglow/util";
import { describe, expect, it } from "vitest";

import { itExpectFail } from "../../itExpectFail";
import type {
  ConformanceFixture,
  HumanConnectorConformanceHandle,
  HumanConnectorConformanceOpts,
} from "../types";

function elicitReq(
  fixture: ConformanceFixture,
  requestId: string,
  mode: "single" | "multi-turn"
): IHumanRequest {
  return {
    requestId,
    targetHumanId: "default",
    kind: "elicit",
    message: "Multi-turn step.",
    contentSchema: fixture.elicitContentSchema,
    contentData: undefined,
    expectsResponse: true,
    mode,
    metadata: undefined,
  };
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  return e.name === "AbortError" || /abort/i.test(e.message ?? "");
}

export function multiTurnFollowUpBlock(
  opts: HumanConnectorConformanceOpts,
  fixture: ConformanceFixture,
  getHandle: () => HumanConnectorConformanceHandle
): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itFn = expectFails.has("multiTurn.followUp") ? itExpectFail : it;

  describe.skipIf(!opts.capabilities.multiTurn || !opts.capabilities.elicit)(
    "Multi-turn followUp",
    () => {
      itFn(
        "followUp() called after done=false response returns terminal response",
        async () => {
          const { connector, script } = getHandle();
          script.push({
            requestId: "x",
            action: "accept",
            content: { approved: false, reason: "step1" },
            done: false,
          });
          script.push({
            requestId: "x",
            action: "accept",
            content: { approved: true, reason: "step2" },
            done: true,
          });

          const ac = new AbortController();
          const req = elicitReq(fixture, "mt-1", "multi-turn");
          const first = await connector.send(req, ac.signal);
          expect(first.done).toBe(false);

          expect(typeof connector.followUp).toBe("function");
          const second = await connector.followUp!(req, first, ac.signal);
          expect(second.done).toBe(true);
          expect(second.content).toEqual({ approved: true, reason: "step2" });
        },
        opts.timeout
      );

      if (opts.capabilities.abortMidElicit) {
        itFn(
          "followUp() honors AbortSignal mid-flight",
          async () => {
            const { connector, script } = getHandle();
            script.push({
              requestId: "x",
              action: "accept",
              content: { approved: false, reason: "step1" },
              done: false,
            });
            script.pushDeferred();
            const ac = new AbortController();
            const req = elicitReq(fixture, "mt-2", "multi-turn");
            const first = await connector.send(req, ac.signal);
            expect(first.done).toBe(false);
            const promise = connector.followUp!(req, first, ac.signal);
            setTimeout(() => ac.abort(), 25);
            let caught: unknown;
            try {
              await promise;
            } catch (err) {
              caught = err;
            }
            expect(caught).toBeDefined();
            expect(isAbortError(caught)).toBe(true);
          },
          opts.timeout
        );
      }
    }
  );
}
