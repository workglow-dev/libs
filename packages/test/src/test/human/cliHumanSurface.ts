/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { humanPromptModel } from "@workglow/cli/human";
import type { HumanPromptSource } from "@workglow/cli/human";
import type { IHumanRequest, IHumanResponse } from "@workglow/util";

import { MockHumanConnector } from "@workglow/test-contract/human-connector";
import type { MockResponseScript } from "@workglow/test-contract/human-connector";

/**
 * A person sitting in front of what the CLI actually drew.
 *
 * The scripted answer says what they want to say; `humanPromptModel` says what
 * the panel or card lets them say. When the rendering offers the scripted
 * action they give it, and otherwise they are left with the rendering's primary
 * action — which is the whole point of driving the suite through the model
 * rather than around it: a confirm drawn as a form has no "decline" to press,
 * so `roundtrip.confirm.decline` fails instead of passing on an answer no
 * rendering could have produced.
 *
 * The scripted queue, deferred entries, abort handling and the notify/display
 * fast path come from {@link MockHumanConnector}, so the surface under test is
 * the rendering and nothing else.
 */
export interface CliHumanSurface {
  readonly script: MockResponseScript;
  answer(request: IHumanRequest, signal: AbortSignal): Promise<IHumanResponse>;
}

export function createCliHumanSurface(
  sourceOf: (request: IHumanRequest) => HumanPromptSource = requestAsPromptSource
): CliHumanSurface {
  const scripted = new MockHumanConnector({ supportsFollowUp: false });
  return {
    script: scripted.script,
    answer: async (request, signal) => {
      const wanted = await scripted.send(request, signal);
      const model = humanPromptModel(sourceOf(request));
      const action = model.actions.includes(wanted.action) ? wanted.action : model.actions[0]!;
      return {
        requestId: request.requestId,
        action,
        content: action === "accept" && model.carriesContent ? wanted.content : undefined,
        done: wanted.done,
      };
    },
  };
}

/** What the Ink host holds: the request itself. */
export function requestAsPromptSource(request: IHumanRequest): HumanPromptSource {
  return {
    kind: request.kind,
    message: request.message,
    schema: request.contentSchema,
    data: request.contentData,
  };
}
