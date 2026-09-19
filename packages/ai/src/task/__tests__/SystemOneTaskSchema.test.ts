/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { CAPABILITIES, registerAiTasks, SystemOneTask } from "@workglow/ai";
import { TaskRegistry } from "@workglow/task-graph";
import { compileSchema } from "@workglow/util/schema";
import { describe, expect, it } from "vitest";

function validate(schema: unknown, value: unknown) {
  const compiled = compileSchema(schema as any);
  return compiled.validate(value);
}

const MODEL = "typesafe:jev-latest";

const noul = { type: "noul", instructions: "Does this convey urgency?" };
const choice = {
  type: "choice",
  instructions: "Which team should handle this?",
  criteria: { billing: "Payments and refunds", technical: null },
};
const score = {
  type: "score",
  instructions: "How frustrated is the customer?",
  criteria: ["Calm", "Frustrated", "Very angry"],
};

describe("SystemOneTask statics", () => {
  it("declares its type, category and required capability", () => {
    expect(SystemOneTask.type).toBe("SystemOneTask");
    expect(SystemOneTask.category).toBe("AI Text");
    expect(SystemOneTask.requires).toEqual(["judgment.systemone"]);
    expect(CAPABILITIES["judgment.systemone"]).toBeDefined();
  });

  // Registration is what lets graph JSON name the task; it is centralized in
  // `registerAiTasks` rather than being a module side effect.
  it("is registered by registerAiTasks, so a saved graph can name it", () => {
    registerAiTasks();
    expect(TaskRegistry.all.get("SystemOneTask")).toBe(SystemOneTask);
  });
});

describe("SystemOneTask input schema", () => {
  it("accepts all three question types over one state", () => {
    const result = validate(SystemOneTask.inputSchema(), {
      model: MODEL,
      state: { ticket: "I was charged twice." },
      questions: { urgent: noul, department: choice, frustration: score },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts a plain-string state", () => {
    const result = validate(SystemOneTask.inputSchema(), {
      model: MODEL,
      state: "I was charged twice.",
      questions: { urgent: noul },
    });
    expect(result.valid).toBe(true);
  });

  // The whole point of the task is to batch questions over one state, so an
  // empty map is a request that cannot mean anything.
  it("rejects an empty question map", () => {
    const result = validate(SystemOneTask.inputSchema(), {
      model: MODEL,
      state: "x",
      questions: {},
    });
    expect(result.valid).toBe(false);
  });

  it("rejects input missing state or questions", () => {
    expect(
      validate(SystemOneTask.inputSchema(), { model: MODEL, questions: { urgent: noul } }).valid
    ).toBe(false);
    expect(validate(SystemOneTask.inputSchema(), { model: MODEL, state: "x" }).valid).toBe(false);
  });

  it("rejects a question with no discriminating type", () => {
    const result = validate(SystemOneTask.inputSchema(), {
      model: MODEL,
      state: "x",
      questions: { q: { instructions: "?" } },
    });
    expect(result.valid).toBe(false);
  });

  // A one-level rubric has no direction to rate along, and the API refuses it.
  it("rejects a score question with fewer than two levels", () => {
    const result = validate(SystemOneTask.inputSchema(), {
      model: MODEL,
      state: "x",
      questions: { q: { type: "score", instructions: "?", criteria: ["Calm"] } },
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a choice question with fewer than two options", () => {
    const result = validate(SystemOneTask.inputSchema(), {
      model: MODEL,
      state: "x",
      questions: { q: { type: "choice", instructions: "?", criteria: { billing: null } } },
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a score question carrying no criteria at all", () => {
    const result = validate(SystemOneTask.inputSchema(), {
      model: MODEL,
      state: "x",
      questions: { q: { type: "score", instructions: "?" } },
    });
    expect(result.valid).toBe(false);
  });

  // Instructions and criteria take JSON structure, not only prose — that is how
  // definitions, contrasts and examples are expressed.
  it("accepts structured instructions and structured option descriptions", () => {
    const result = validate(SystemOneTask.inputSchema(), {
      model: MODEL,
      state: "x",
      questions: {
        q: {
          type: "choice",
          instructions: { task: "Route the ticket", exclude: ["spam"] },
          criteria: {
            billing: { includes: ["refunds"], excludes: ["pricing questions"] },
            technical: null,
          },
        },
      },
    });
    expect(result.valid).toBe(true);
  });
});

describe("SystemOneTask output schema", () => {
  it("accepts one answer of each type under the caller's own keys", () => {
    const result = validate(SystemOneTask.outputSchema(), {
      answers: {
        urgent: { type: "noul", noul: 0.92 },
        department: {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 0.85, technical: 0.15 },
          confidence: 0.82,
        },
        frustration: {
          type: "score",
          score: 1.6,
          legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
          probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
          confidence: 0.78,
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  // Confidence is what a caller thresholds on, so an answer that arrives
  // without it must not validate as a complete one.
  it("rejects a choice answer missing its distribution or confidence", () => {
    expect(
      validate(SystemOneTask.outputSchema(), {
        answers: { d: { type: "choice", choice: "billing", confidence: 0.8 } },
      }).valid
    ).toBe(false);
    expect(
      validate(SystemOneTask.outputSchema(), {
        answers: { d: { type: "choice", choice: "billing", probabilities: { billing: 1 } } },
      }).valid
    ).toBe(false);
  });

  // A noul is a probability, not a boolean — a `true` here would mean a caller
  // had thresholded somewhere upstream and thrown the number away.
  it("rejects a boolean in place of a noul", () => {
    const result = validate(SystemOneTask.outputSchema(), {
      answers: { urgent: { type: "noul", noul: true } },
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a noul outside 0..1", () => {
    expect(
      validate(SystemOneTask.outputSchema(), { answers: { u: { type: "noul", noul: 1.5 } } }).valid
    ).toBe(false);
  });
});
