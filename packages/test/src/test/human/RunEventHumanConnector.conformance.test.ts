/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { emptyRunView, reduceRunEvent, RunEventHumanConnector } from "@workglow/cli/human";
import type { RunEvent, RunEventSink } from "@workglow/cli/human";
import type { IHumanRequest } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";

import { runHumanConnectorConformance } from "@workglow/test-contract/human-connector";
import { createCliHumanSurface } from "./cliHumanSurface";

/**
 * The web console's connector, answered through what the console can draw.
 *
 * The request is reduced into the console's own view state first, so the
 * assertions see exactly what reaches the browser: a field the event stream
 * never carried, or the reducer dropped, is a field the person deciding never
 * had.
 */
runHumanConnectorConformance({
  name: "RunEventHumanConnector",
  timeout: 10_000,
  factory: async () => {
    const surface = createCliHumanSurface();
    let onLine: ((line: string) => void) | undefined;

    const answer = (event: Extract<RunEvent, { k: "human_request" }>): void => {
      const view = reduceRunEvent(emptyRunView(), event);
      const shown = view.humanRequest;
      if (!shown) return;
      const request: IHumanRequest = {
        requestId: shown.requestId,
        targetHumanId: "default",
        // Everything the console does not know is a form to fill in — which is
        // what it falls back to when the stream carries no kind.
        kind: (shown as { kind?: IHumanRequest["kind"] }).kind ?? "elicit",
        message: shown.message,
        contentSchema: (shown.schema ?? {}) as DataPortSchema,
        contentData: (shown as { data?: Record<string, unknown> }).data,
        expectsResponse: true,
        mode: "single",
        metadata: undefined,
      };
      void surface.answer(request, new AbortController().signal).then(
        (response) => onLine?.(JSON.stringify(response)),
        () => undefined
      );
    };

    const sink: RunEventSink = {
      emit: (event) => {
        if (event.k === "human_request") answer(event);
      },
      close: async () => {},
    };

    return {
      connector: new RunEventHumanConnector(sink, (handler) => {
        onLine = handler;
        return () => {
          onLine = undefined;
        };
      }),
      script: surface.script,
      dispose: async () => {},
    };
  },
  capabilities: {
    elicit: true,
    confirm: true,
    notify: true,
    display: true,
    multiTurn: true,
    concurrent: true,
    // An abort resolves as `cancel` rather than rejecting: this connector runs
    // in a child process whose question nobody is reading any more, and a
    // rejection would surface as a task failure rather than the cancellation it
    // is. `abort.beforeSend` states the opposite, so it is declared failing.
    abortMidElicit: false,
  },
  expectedFailures: ["abort.beforeSend"],
});
