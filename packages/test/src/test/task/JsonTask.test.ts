/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskInvalidInputError } from "@workglow/task-graph";
import { JsonTask } from "@workglow/tasks";
import { setLogger } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { describe, expect, it } from "vitest";

setLogger(getTestingLogger());

describe("JsonTask", () => {
  it("refuses text that is not JSON as invalid input", () => {
    expect(() => new JsonTask({ defaults: { json: "{ not json" } })).toThrow(TaskInvalidInputError);
  });

  it("refuses graph JSON of the wrong shape before building anything, saying why", () => {
    const json = JSON.stringify({ tasks: [{ id: "a" }], dataflows: [] });
    expect(() => new JsonTask({ defaults: { json } })).toThrow(TaskInvalidInputError);
  });
});
