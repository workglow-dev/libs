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

function confirmReq(fixture: ConformanceFixture, requestId: string): IHumanRequest {
  return {
    requestId,
    targetHumanId: "default",
    kind: "confirm",
    message: fixture.confirmRequest.message,
    contentSchema: fixture.confirmRequest.contentSchema,
    contentData: fixture.confirmRequest.contentData,
    expectsResponse: true,
    mode: "single",
    metadata: undefined,
  };
}

export function roundtripBlock(
  opts: HumanConnectorConformanceOpts,
  fixture: ConformanceFixture,
  getHandle: () => HumanConnectorConformanceHandle
): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itAccept = expectFails.has("roundtrip.accept") ? itExpectFail : it;
  const itDecline = expectFails.has("roundtrip.decline") ? itExpectFail : it;
  const itCancel = expectFails.has("roundtrip.cancel") ? itExpectFail : it;
  const itConfirmAccept = expectFails.has("roundtrip.confirm.accept") ? itExpectFail : it;
  const itConfirmDecline = expectFails.has("roundtrip.confirm.decline") ? itExpectFail : it;
  const itConfirmDetails = expectFails.has("roundtrip.confirm.details") ? itExpectFail : it;
  const itConfirmNoContent = expectFails.has("roundtrip.confirm.noContent") ? itExpectFail : it;

  describe.skipIf(!opts.capabilities.elicit)("Roundtrip elicit", () => {
    itAccept(
      "accept echoes requestId, returns done=true, surfaces content",
      async () => {
        const { connector, script } = getHandle();
        script.push({
          requestId: "ignored",
          action: "accept",
          content: fixture.elicitAcceptContent,
          done: true,
        });
        const ac = new AbortController();
        const res = await connector.send(elicitReq(fixture, "rt-accept-1"), ac.signal);
        expect(res.requestId).toBe("rt-accept-1");
        expect(res.action).toBe("accept");
        expect(res.done).toBe(true);
        expect(res.content).toEqual(fixture.elicitAcceptContent);
      },
      opts.timeout
    );

    itDecline(
      "decline surfaces with content=undefined, no throw",
      async () => {
        const { connector, script } = getHandle();
        script.push({ requestId: "x", action: "decline", content: undefined, done: true });
        const ac = new AbortController();
        const res = await connector.send(elicitReq(fixture, "rt-dec-1"), ac.signal);
        expect(res.requestId).toBe("rt-dec-1");
        expect(res.action).toBe("decline");
        expect(res.done).toBe(true);
        expect(res.content).toBeUndefined();
      },
      opts.timeout
    );

    itCancel(
      "cancel surfaces with content=undefined, no throw",
      async () => {
        const { connector, script } = getHandle();
        script.push({ requestId: "x", action: "cancel", content: undefined, done: true });
        const ac = new AbortController();
        const res = await connector.send(elicitReq(fixture, "rt-can-1"), ac.signal);
        expect(res.requestId).toBe("rt-can-1");
        expect(res.action).toBe("cancel");
        expect(res.done).toBe(true);
        expect(res.content).toBeUndefined();
      },
      opts.timeout
    );
  });

  // Declaring `confirm: true` is a claim that a person decided. Without a
  // positive case the honesty block above proves nothing — it returns early
  // whenever the capability is true — so a connector that answered "accept"
  // without asking anyone would pass the whole suite.
  describe.skipIf(!opts.capabilities.confirm)("Roundtrip confirm", () => {
    itConfirmAccept(
      "a decision reaches the caller as the person's own answer",
      async () => {
        const { connector, script } = getHandle();
        script.push({ requestId: "x", action: "accept", content: undefined, done: true });
        const ac = new AbortController();
        const res = await connector.send(confirmReq(fixture, "rt-confirm-accept"), ac.signal);
        expect(res.requestId).toBe("rt-confirm-accept");
        expect(res.action).toBe("accept");
        expect(res.done).toBe(true);
      },
      opts.timeout
    );

    itConfirmDecline(
      "a refusal is a refusal, not an unanswered accept",
      async () => {
        const { connector, script } = getHandle();
        script.push({ requestId: "x", action: "decline", content: undefined, done: true });
        const ac = new AbortController();
        const res = await connector.send(confirmReq(fixture, "rt-confirm-decline"), ac.signal);
        expect(res.requestId).toBe("rt-confirm-decline");
        expect(res.action).toBe("decline");
        expect(res.done).toBe(true);
      },
      opts.timeout
    );

    itConfirmNoContent(
      "an accepted confirm answers with the decision and nothing else",
      async () => {
        // A confirm's schema describes the action, so anything a connector
        // sends back under it is an answer to a form nobody asked. It reaches
        // the task's output ports (`HumanInputTask` spreads `content` there),
        // which is how an edit to the DESCRIPTION of an action becomes part of
        // what the graph does with it.
        const { connector, script } = getHandle();
        script.push({
          requestId: "x",
          action: "accept",
          content: { action: "something else" },
          done: true,
        });
        const ac = new AbortController();
        const res = await connector.send(confirmReq(fixture, "rt-confirm-content"), ac.signal);
        expect(res.action).toBe("accept");
        expect(res.content).toBeUndefined();
      },
      opts.timeout
    );

    itConfirmDetails(
      "the action's details reach the person deciding",
      async () => {
        const { connector, script } = getHandle();
        script.push({ requestId: "x", action: "decline", content: undefined, done: true });
        const ac = new AbortController();
        await connector.send(confirmReq(fixture, "rt-confirm-details"), ac.signal);
        const received = script.received.at(-1);
        const shown = JSON.stringify({
          message: received?.message,
          contentData: received?.contentData,
        });
        for (const value of Object.values(fixture.confirmRequest.contentData ?? {})) {
          if (typeof value === "string") expect(shown).toContain(value);
        }
      },
      opts.timeout
    );
  });
}
