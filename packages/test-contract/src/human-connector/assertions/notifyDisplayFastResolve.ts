/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HumanInteractionKind, IHumanRequest } from "@workglow/util";
import { describe, expect, it } from "vitest";

import { itExpectFail } from "../../itExpectFail";
import type {
  ConformanceFixture,
  HumanConnectorAssertionId,
  HumanConnectorConformanceHandle,
  HumanConnectorConformanceOpts,
} from "../types";

function buildReq(
  fixture: ConformanceFixture,
  kind: "notify" | "display",
  requestId: string
): IHumanRequest {
  const base = kind === "notify" ? fixture.notifyRequest : fixture.displayRequest;
  return {
    requestId,
    targetHumanId: "default",
    kind: kind as HumanInteractionKind,
    message: base.message,
    contentSchema: base.contentSchema,
    contentData: base.contentData,
    expectsResponse: false,
    mode: "single",
    metadata: undefined,
  };
}

function elicitReq(fixture: ConformanceFixture, requestId: string): IHumanRequest {
  return {
    requestId,
    targetHumanId: "default",
    kind: "elicit",
    message: "Follow-up after fast-resolve.",
    contentSchema: fixture.elicitContentSchema,
    contentData: undefined,
    expectsResponse: true,
    mode: "single",
    metadata: undefined,
  };
}

function block(
  kind: "notify" | "display",
  enabled: boolean,
  failId: HumanConnectorAssertionId,
  opts: HumanConnectorConformanceOpts,
  fixture: ConformanceFixture,
  getHandle: () => HumanConnectorConformanceHandle
): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itFn = expectFails.has(failId) ? itExpectFail : it;

  describe.skipIf(!enabled || !opts.capabilities.elicit)(`${kind} fast-resolve`, () => {
    itFn(
      `${kind} resolves with action=accept, done=true, and does not consume scripted elicit responses`,
      async () => {
        const { connector, script } = getHandle();
        // Preload an elicit response; if the connector incorrectly consumes
        // the queue on a notify/display request, the next elicit would fall
        // through to the connector's default and the assertion below would
        // surface the regression.
        const sentinel = { approved: true, reason: "sentinel" };
        script.push({ requestId: "ignored", action: "accept", content: sentinel, done: true });

        const ac = new AbortController();
        const res = await connector.send(buildReq(fixture, kind, `${kind}-1`), ac.signal);
        expect(res.action).toBe("accept");
        expect(res.done).toBe(true);
        expect(res.content).toBeUndefined();

        // The elicit response queued before should still be consumable.
        const elicitRes = await connector.send(elicitReq(fixture, `${kind}-elicit-1`), ac.signal);
        expect(elicitRes.action).toBe("accept");
        expect(elicitRes.content).toEqual(sentinel);
        expect(elicitRes.requestId).toBe(`${kind}-elicit-1`);
      },
      opts.timeout
    );
  });
}

export function notifyDisplayFastResolveBlock(
  opts: HumanConnectorConformanceOpts,
  fixture: ConformanceFixture,
  getHandle: () => HumanConnectorConformanceHandle
): void {
  block("notify", opts.capabilities.notify, "notify.fastResolve", opts, fixture, getHandle);
  block("display", opts.capabilities.display, "display.fastResolve", opts, fixture, getHandle);
}
