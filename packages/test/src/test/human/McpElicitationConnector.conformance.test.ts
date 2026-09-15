/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { McpElicitationConnector } from "@workglow/mcp/tasks";

import { runHumanConnectorConformance } from "@workglow/test-contract/human-connector";
import { createPairedMcpHarness } from "./mcpHarness";

runHumanConnectorConformance({
  name: "McpElicitationConnector",
  timeout: 10_000,
  factory: async () => {
    const harness = await createPairedMcpHarness();
    return {
      connector: new McpElicitationConnector(harness.server),
      script: harness.script,
      dispose: harness.dispose,
    };
  },
  capabilities: {
    elicit: true,
    confirm: true,
    notify: true,
    display: true,
    multiTurn: false,
    concurrent: true,
    abortMidElicit: true,
  },
});
