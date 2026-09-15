/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MockHumanConnector,
  runHumanConnectorConformance,
} from "@workglow/test-contract/human-connector";

runHumanConnectorConformance({
  name: "MockHumanConnector (full capabilities)",
  timeout: 5_000,
  factory: async () => {
    const connector = new MockHumanConnector({ supportsFollowUp: true });
    return {
      connector,
      script: connector.script,
      dispose: async () => {
        connector.script.clear();
      },
    };
  },
  capabilities: {
    elicit: true,
    confirm: true,
    notify: true,
    display: true,
    multiTurn: true,
    concurrent: true,
    abortMidElicit: true,
  },
});
