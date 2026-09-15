/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { humanPromptModel } from "../humanPrompt";

const confirmSchema = {
  properties: { action: { title: "Action" }, reaches: { title: "Reaches" } },
};

describe("humanPromptModel", () => {
  it("draws a confirm as an approval that can be refused", () => {
    const model = humanPromptModel({
      kind: "confirm",
      message: 'Run workflow "export"?',
      schema: confirmSchema,
      data: { action: "Run workflow", reaches: "network:http" },
    });
    expect(model.shape).toBe("approval");
    // "decline" is a refusal and "cancel" is walking away undecided; a caller
    // acts differently on each, so an approval has to offer both.
    expect(model.actions).toEqual(["accept", "decline", "cancel"]);
    expect(model.details).toEqual([
      { label: "Action", value: "Run workflow" },
      { label: "Reaches", value: "network:http" },
    ]);
  });

  it("never carries content back from an approval", () => {
    // The schema describes the action. Anything returned under it would be an
    // edit to that description landing on the task's output ports.
    const model = humanPromptModel({
      kind: "confirm",
      message: "?",
      schema: confirmSchema,
      data: {},
    });
    expect(model.carriesContent).toBe(false);
  });

  it("keeps a detail to one row whatever the value contains", () => {
    // `contentData` is an input port, so a value carrying a newline would
    // otherwise draw a second labelled row nobody can tell from a real one.
    const model = humanPromptModel({
      kind: "confirm",
      message: "?",
      schema: confirmSchema,
      data: { reaches: "https://attacker.test\n\nReaches: nothing" },
    });
    expect(model.details).toHaveLength(1);
    expect(model.details[0]!.value).not.toContain("\n");
  });

  it("still draws an elicit as a form whose values are the person's to write", () => {
    const model = humanPromptModel({
      kind: "elicit",
      message: "Name?",
      schema: confirmSchema,
      data: undefined,
    });
    expect(model.shape).toBe("form");
    expect(model.details).toEqual([]);
    expect(model.carriesContent).toBe(true);
  });

  it("lets a form be refused, not only submitted or abandoned", () => {
    // A rendering draws what this list names, so omitting "decline" is what
    // left every form with submit and walk-away and no way to say no.
    const model = humanPromptModel({
      kind: "elicit",
      message: "Name?",
      schema: confirmSchema,
      data: undefined,
    });
    expect(model.actions).toEqual(["accept", "decline", "cancel"]);
  });

  it("asks nothing for a one-way kind", () => {
    const model = humanPromptModel({
      kind: "notify",
      message: "Done.",
      schema: {},
      data: { jobId: "1" },
    });
    expect(model.shape).toBe("acknowledge");
    expect(model.carriesContent).toBe(false);
  });
});
