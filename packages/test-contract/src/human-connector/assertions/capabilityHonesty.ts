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
  HumanConnectorConformanceHandle,
  HumanConnectorConformanceOpts,
} from "../types";

function buildReq(
  fixture: ConformanceFixture,
  kind: HumanInteractionKind,
  requestId: string
): IHumanRequest {
  const base =
    kind === "elicit"
      ? { message: "elicit", contentSchema: fixture.elicitContentSchema, contentData: undefined }
      : kind === "notify"
        ? fixture.notifyRequest
        : kind === "confirm"
          ? fixture.confirmRequest
          : fixture.displayRequest;
  return {
    requestId,
    targetHumanId: "default",
    kind,
    message: base.message,
    contentSchema: base.contentSchema,
    contentData: base.contentData,
    expectsResponse: kind === "elicit" || kind === "confirm",
    mode: "single",
    metadata: undefined,
  };
}

export function capabilityHonestyBlock(
  opts: HumanConnectorConformanceOpts,
  fixture: ConformanceFixture,
  getHandle: () => HumanConnectorConformanceHandle
): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itFn = expectFails.has("capabilityHonesty") ? itExpectFail : it;

  describe("Capability honesty", () => {
    itFn(
      "multiTurn:false implies followUp is undefined (not silent no-op)",
      () => {
        if (opts.capabilities.multiTurn) return;
        const { connector } = getHandle();
        expect(connector.followUp).toBeUndefined();
      },
      opts.timeout
    );

    for (const kind of ["notify", "display", "elicit", "confirm"] as const) {
      itFn(
        `${kind}:false implies the connector either throws or surfaces a non-accept action (no silent accept)`,
        async () => {
          if (opts.capabilities[kind]) return;
          const { connector } = getHandle();
          const ac = new AbortController();
          let caught: unknown;
          let res: { action?: string } | undefined;
          try {
            res = await connector.send(buildReq(fixture, kind, `cap-${kind}`), ac.signal);
          } catch (err) {
            caught = err;
          }
          if (caught) {
            expect(caught).toBeDefined();
            return;
          }
          expect(res).toBeDefined();
          expect(res!.action).not.toBe("accept");
        },
        opts.timeout
      );
    }
  });
}
