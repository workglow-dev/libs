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

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  return e.name === "AbortError" || /abort/i.test(e.message ?? "");
}

function elicitReq(fixture: ConformanceFixture, requestId: string): IHumanRequest {
  return {
    requestId,
    targetHumanId: "default",
    kind: "elicit",
    message: "Please confirm.",
    contentSchema: fixture.elicitContentSchema,
    contentData: undefined,
    expectsResponse: true,
    mode: "single",
    metadata: undefined,
  };
}

export function abortBlock(
  opts: HumanConnectorConformanceOpts,
  fixture: ConformanceFixture,
  getHandle: () => HumanConnectorConformanceHandle
): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itBefore = expectFails.has("abort.beforeSend") ? itExpectFail : it;
  const itMid = expectFails.has("abort.midElicit") ? itExpectFail : it;

  describe.skipIf(!opts.capabilities.elicit)("Abort", () => {
    itBefore(
      "send() with already-aborted signal rejects with AbortError",
      async () => {
        const { connector } = getHandle();
        const ac = new AbortController();
        ac.abort();
        let caught: unknown;
        try {
          await connector.send(elicitReq(fixture, "ab-pre-1"), ac.signal);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeDefined();
        expect(isAbortError(caught)).toBe(true);
      },
      opts.timeout
    );

    if (opts.capabilities.abortMidElicit) {
      itMid(
        "send() rejects with AbortError when signal aborts mid-elicit",
        async () => {
          const { connector, script } = getHandle();
          const handle = script.pushDeferred();
          const ac = new AbortController();
          const start = Date.now();
          const promise = connector.send(elicitReq(fixture, "ab-mid-1"), ac.signal);
          setTimeout(() => ac.abort(), 25);

          let caught: unknown;
          try {
            await promise;
          } catch (err) {
            caught = err;
          }
          const elapsed = Date.now() - start;
          expect(caught).toBeDefined();
          expect(isAbortError(caught)).toBe(true);
          expect(elapsed).toBeLessThan(fixture.abortGraceMs * 4 + 2000);
          // Releasing after rejection must not throw or produce a stray response.
          expect(() =>
            handle.release({
              requestId: "x",
              action: "accept",
              content: undefined,
              done: true,
            })
          ).not.toThrow();
        },
        opts.timeout
      );
    }
  });
}
