/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, beforeEach, describe } from "vitest";

import { abortBlock } from "./assertions/abort";
import { capabilityHonestyBlock } from "./assertions/capabilityHonesty";
import { concurrentIsolationBlock } from "./assertions/concurrentIsolation";
import { multiTurnFollowUpBlock } from "./assertions/multiTurnFollowUp";
import { notifyDisplayFastResolveBlock } from "./assertions/notifyDisplayFastResolve";
import { roundtripBlock } from "./assertions/roundtrip";
import { resolveHumanConformanceFixture } from "./fixtures";
import type { HumanConnectorConformanceHandle, HumanConnectorConformanceOpts } from "./types";

export { MockHumanConnector } from "./MockHumanConnector";
export type { HumanConnectorConformanceOpts } from "./types";

export function runHumanConnectorConformance(opts: HumanConnectorConformanceOpts): void {
  describe.skipIf(opts.skip)(`IHumanConnector conformance: ${opts.name}`, () => {
    let handle: HumanConnectorConformanceHandle | undefined;
    const getHandle = (): HumanConnectorConformanceHandle => {
      if (!handle) throw new Error("conformance handle not initialized");
      return handle;
    };

    beforeAll(async () => {
      handle = await opts.factory();
    }, opts.timeout);

    beforeEach(() => {
      // Each assertion starts from a clean script + received list.
      handle?.script.clear();
    });

    afterAll(async () => {
      if (handle) await handle.dispose();
    });

    const fixture = resolveHumanConformanceFixture(opts.fixture);

    roundtripBlock(opts, fixture, getHandle);
    abortBlock(opts, fixture, getHandle);
    concurrentIsolationBlock(opts, fixture, getHandle);
    notifyDisplayFastResolveBlock(opts, fixture, getHandle);
    multiTurnFollowUpBlock(opts, fixture, getHandle);
    capabilityHonestyBlock(opts, fixture, getHandle);
  });
}
