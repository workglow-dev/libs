/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { InkHumanConnector, setCliHumanInteractionEnqueue } from "@workglow/cli/human";

import { runHumanConnectorConformance } from "@workglow/test-contract/human-connector";
import { createCliHumanSurface } from "./cliHumanSurface";

/**
 * The terminal connector, answered through what its Ink host actually draws.
 *
 * The bridge the host installs is stood in for here so the suite can script the
 * person's side, but every answer still has to be one the drawn panel offers —
 * see {@link createCliHumanSurface}.
 */
runHumanConnectorConformance({
  name: "InkHumanConnector",
  timeout: 10_000,
  factory: async () => {
    const surface = createCliHumanSurface();
    setCliHumanInteractionEnqueue(surface.answer);
    return {
      connector: new InkHumanConnector(),
      script: surface.script,
      dispose: async () => {
        setCliHumanInteractionEnqueue(undefined);
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
  // The elicit form offers submit and Esc, so a person can walk away from it
  // but cannot refuse it. Unlike a confirm, nothing turns on the difference
  // there yet — an elicit's caller wanted a value and gets none either way —
  // so this is recorded rather than papered over.
  expectedFailures: ["roundtrip.decline"],
});
