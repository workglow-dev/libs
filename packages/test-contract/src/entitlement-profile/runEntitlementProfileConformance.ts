/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe } from "vitest";

import { denialShapeBlock } from "./assertions/denialShape";
import { disposeBlock } from "./assertions/dispose";
import { hierarchyHonoringBlock } from "./assertions/hierarchyHonoring";
import { optionalNeverDeniedBlock } from "./assertions/optionalNeverDenied";
import { requestEntitlementShapeBlock } from "./assertions/requestEntitlementShape";
import { resourceScopingBlock } from "./assertions/resourceScoping";
import { subscribeGrantBlock } from "./assertions/subscribeGrant";
import { subscribeReloadBlock } from "./assertions/subscribeReload";
import { subscribeRevocationBlock } from "./assertions/subscribeRevocation";
import { surfaceCoverageBlock } from "./assertions/surfaceCoverage";
import { unsubscribeIdempotentBlock } from "./assertions/unsubscribeIdempotent";
import type {
  EntitlementProfileConformanceHandle,
  EntitlementProfileConformanceOpts,
} from "./types";

export function runEntitlementProfileConformance(opts: EntitlementProfileConformanceOpts): void {
  describe.skipIf(opts.skip)(`EntitlementProfile conformance: ${opts.name}`, () => {
    let handle: EntitlementProfileConformanceHandle | undefined;
    const getHandle = (): EntitlementProfileConformanceHandle => {
      if (!handle) throw new Error("conformance handle not initialized");
      return handle;
    };

    beforeAll(async () => {
      handle = await opts.factory();
    }, opts.timeout);

    afterAll(async () => {
      if (handle) await handle.dispose();
    });

    // Assertion blocks are imported and invoked here as they are added.
    surfaceCoverageBlock(opts, getHandle);
    hierarchyHonoringBlock(opts, getHandle);
    resourceScopingBlock(opts, getHandle);
    optionalNeverDeniedBlock(opts, getHandle);
    denialShapeBlock(opts, getHandle);
    requestEntitlementShapeBlock(opts, getHandle);
    subscribeRevocationBlock(opts, getHandle);
    subscribeGrantBlock(opts, getHandle);
    subscribeReloadBlock(opts, getHandle);
    unsubscribeIdempotentBlock(opts, getHandle);
    disposeBlock(opts, getHandle);
  });
}
