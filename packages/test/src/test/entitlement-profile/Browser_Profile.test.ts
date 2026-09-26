/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { Entitlements, createProfileEnforcer } from "@workglow/task-graph";

import { runEntitlementProfileConformance } from "@workglow/test-contract/entitlement-profile";

runEntitlementProfileConformance({
  name: "browser",
  timeout: 5_000,
  factory: async () => {
    const profile = createProfileEnforcer("browser");
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
      Entitlements.NETWORK_WEBSOCKET,
      Entitlements.AI,
      Entitlements.MCP_TOOL_CALL,
      Entitlements.STORAGE,
      Entitlements.CREDENTIAL,
      Entitlements.CODE_EXECUTION_JS,
    ],
    surfaceExcludes: [
      Entitlements.FILESYSTEM,
      Entitlements.CODE_EXECUTION,
      Entitlements.MCP_STDIO,
      Entitlements.BROWSER_CONTROL,
    ],
  },
});
