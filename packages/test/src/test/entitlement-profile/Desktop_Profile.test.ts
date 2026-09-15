/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { Entitlements, createProfileEnforcer } from "@workglow/task-graph";

import { runEntitlementProfileConformance } from "@workglow/test-contract/entitlement-profile";

runEntitlementProfileConformance({
  name: "desktop",
  timeout: 5_000,
  factory: async () => {
    const profile = createProfileEnforcer("desktop");
    return {
      profile,
      dispose: () => profile.dispose(),
    };
  },
  capabilities: {
    mutableSignalSource: false,
    hierarchyHonoring: true,
    resourceScoping: true,
  },
  expected: {
    surfaceIncludes: [
      Entitlements.NETWORK_HTTP,
      Entitlements.FILESYSTEM,
      Entitlements.CODE_EXECUTION,
      Entitlements.MCP_STDIO,
      Entitlements.BROWSER_CONTROL_LOCAL,
    ],
    surfaceExcludes: [
      // Desktop intentionally does NOT include the cloud variant.
      Entitlements.BROWSER_CONTROL_CLOUD,
    ],
  },
});
