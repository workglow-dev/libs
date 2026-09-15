/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { PromptHumanConnector } from "@workglow/cli/human";
import type { PromptHumanRenderers } from "@workglow/cli/human";
import type { IHumanRequest } from "@workglow/util";
import { describe, expect, it } from "vitest";

/**
 * What the connector makes of each outcome its form can report.
 *
 * The conformance suite drives every connector through `humanPromptModel`, so
 * it measures what a rendering is ALLOWED to offer. These go through the
 * connector's own injectable renderers instead, which is what the seam exists
 * for: the mapping from a form's three outcomes to a response is the
 * connector's, and nothing else asserts it.
 */
function elicitRequest(): IHumanRequest {
  return {
    requestId: "unit-1",
    targetHumanId: "default",
    kind: "elicit",
    message: "Name?",
    contentSchema: { type: "object", properties: { name: { type: "string" } } },
    contentData: undefined,
    expectsResponse: true,
    mode: "single",
    metadata: undefined,
  };
}

function connectorWith(form: PromptHumanRenderers["form"]): PromptHumanConnector {
  return new PromptHumanConnector({
    select: async () => undefined,
    form,
    notice: () => {},
  });
}

describe("PromptHumanConnector form outcomes", () => {
  it("reports a refusal as decline, carrying no content", async () => {
    // Not "cancel": a person who pressed Decline considered the request and
    // said no, which is the distinction `HumanResponseAction` draws. And not
    // partial values — anything under the schema would reach the task's output
    // ports as if the person had written it.
    const connector = connectorWith(async () => ({ status: "declined" }));
    const res = await connector.send(elicitRequest(), new AbortController().signal);
    expect(res.action).toBe("decline");
    expect(res.content).toBeUndefined();
    expect(res.done).toBe(true);
    expect(res.requestId).toBe("unit-1");
  });

  it("reports walking away as cancel", async () => {
    const connector = connectorWith(async () => ({ status: "cancelled" }));
    const res = await connector.send(elicitRequest(), new AbortController().signal);
    expect(res.action).toBe("cancel");
    expect(res.content).toBeUndefined();
  });

  it("reports a submission as accept, with the values", async () => {
    const connector = connectorWith(async () => ({
      status: "submitted",
      values: { name: "ada" },
    }));
    const res = await connector.send(elicitRequest(), new AbortController().signal);
    expect(res.action).toBe("accept");
    expect(res.content).toEqual({ name: "ada" });
  });
});
