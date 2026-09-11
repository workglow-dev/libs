/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { PromptHumanConnector } from "@workglow/cli/human";
import type { PromptHumanRenderers } from "@workglow/cli/human";
import type { IHumanConnector, IHumanRequest, IHumanResponse } from "@workglow/util";

import { runHumanConnectorConformance } from "../../contract/human-connector/runHumanConnectorConformance";
import { createCliHumanSurface } from "./cliHumanSurface";

/**
 * The connector a command uses when it prompts BETWEEN runs rather than during
 * one, answered through what its prompts actually offer.
 *
 * The renderers are bound per request rather than per connector: the suite runs
 * several requests at once, and a single "current request" would answer them in
 * whatever order they happened to interleave. The connector holds no state, so
 * one per request costs nothing.
 */
function connectorFor(
  surface: ReturnType<typeof createCliHumanSurface>,
  request: IHumanRequest
): PromptHumanConnector {
  // The scripted person is deliberately NOT given the caller's signal: a real
  // Ink prompt cannot reject, it can only be torn down, so letting the stand-in
  // reject would make the abort assertions pass on the mock's behaviour instead
  // of the connector's own race.
  const patient = new AbortController().signal;
  const answer = (): Promise<IHumanResponse> => surface.answer(request, patient);
  const renderers: PromptHumanRenderers = {
    select: async () => {
      const wanted = await answer();
      // Esc on the picker is how a person walks away; the two decisions it
      // offers are the other two answers.
      if (wanted.action === "cancel") return undefined;
      return wanted.action;
    },
    form: async () => {
      const wanted = await answer();
      if (wanted.action !== "accept") return undefined;
      return wanted.content ?? {};
    },
    notice: () => {},
  };
  return new PromptHumanConnector(renderers);
}

runHumanConnectorConformance({
  name: "PromptHumanConnector",
  timeout: 10_000,
  factory: async () => {
    const surface = createCliHumanSurface();
    // No `followUp`, matching the connector: the suite checks that a
    // multiTurn:false connector does not carry one.
    const connector: IHumanConnector = {
      send: (request, signal) => connectorFor(surface, request).send(request, signal),
    };
    return { connector, script: surface.script, dispose: async () => {} };
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
  // The form offers submit and Esc, so a person can walk away from an elicit
  // but cannot refuse it — the same gap the Ink panel has, and for the same
  // reason: nothing yet turns on the difference for an elicit's caller.
  expectedFailures: ["roundtrip.decline"],
});
