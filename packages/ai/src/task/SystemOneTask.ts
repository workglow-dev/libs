/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IRunConfig, TaskConfig } from "@workglow/task-graph";
import { CreateWorkflow, Workflow } from "@workglow/task-graph";
import type { DataPortSchema, DataPortSchemaNonBoolean } from "@workglow/util/schema";
import type { Capability } from "../capability/Capabilities";
import type { ModelConfig } from "../model/ModelSchema";
import { AiTask } from "./base/AiTask";
import { TypeModel } from "./base/AiTaskSchemas";

const modelSchema = TypeModel("model:SystemOneTask");

/**
 * The shapes a question's text may take: a plain string, or a JSON object or
 * array when definitions, contrasts or examples need structure of their own.
 * Named once because `state`, `instructions`, every option description and
 * every score level all accept the same three.
 */
const EntrySchema = {
  anyOf: [{ type: "string" }, { type: "object", additionalProperties: true }, { type: "array" }],
} as const satisfies DataPortSchemaNonBoolean;

/** {@link EntrySchema} widened with the explicit "no description" value. */
const DescribedEntrySchema = {
  anyOf: [...EntrySchema.anyOf, { type: "null" }],
} as const satisfies DataPortSchemaNonBoolean;

const NoulQuestionSchema = {
  type: "object",
  title: "Yes / no",
  description:
    "A yes/no question. The answer is the probability that the answer is yes, not a boolean.",
  properties: {
    type: { const: "noul" },
    instructions: {
      ...EntrySchema,
      title: "Instructions",
      description: "The yes/no question to evaluate against the state",
    },
    criteria: {
      type: "object",
      title: "Criteria",
      description: "Optional descriptions of what a yes and a no mean",
      properties: {
        true: { ...EntrySchema, title: "Yes means", description: "What a value near 1 means" },
        false: { ...EntrySchema, title: "No means", description: "What a value near 0 means" },
      },
      additionalProperties: false,
    },
  },
  required: ["type", "instructions"],
  additionalProperties: false,
} as const satisfies DataPortSchemaNonBoolean;

const ChoiceQuestionSchema = {
  type: "object",
  title: "Choice",
  description:
    "Selects one option from a set you define. The answer carries the chosen option, the probability of every option, and a confidence.",
  properties: {
    type: { const: "choice" },
    instructions: {
      ...EntrySchema,
      title: "Instructions",
      description: "What the model should decide",
    },
    criteria: {
      type: "object",
      title: "Options",
      description:
        "Option name → a description of that option, or null for an option needing no detail",
      additionalProperties: DescribedEntrySchema,
      minProperties: 2,
    },
  },
  required: ["type", "instructions", "criteria"],
  additionalProperties: false,
} as const satisfies DataPortSchemaNonBoolean;

const ScoreQuestionSchema = {
  type: "object",
  title: "Score",
  description:
    "Rates the state along an ordered rubric. The answer is a probability-weighted position across the levels and may land between two of them.",
  properties: {
    type: { const: "score" },
    instructions: {
      ...EntrySchema,
      title: "Instructions",
      description: "What the model should rate",
    },
    criteria: {
      type: "array",
      title: "Levels",
      description:
        "Ordered level descriptions, lowest first. Each level describes a concrete situation and stands on its own.",
      items: DescribedEntrySchema,
      minItems: 2,
    },
  },
  required: ["type", "instructions", "criteria"],
  additionalProperties: false,
} as const satisfies DataPortSchemaNonBoolean;

const QuestionSchema = {
  oneOf: [NoulQuestionSchema, ChoiceQuestionSchema, ScoreQuestionSchema],
  title: "Question",
  description: "One typed question, discriminated by its `type` field",
} as const satisfies DataPortSchemaNonBoolean;

const NoulAnswerSchema = {
  type: "object",
  properties: {
    type: { const: "noul" },
    noul: {
      type: "number",
      title: "Noul",
      description: "The yes/no answer from 0 (no) to 1 (yes)",
      minimum: 0,
      maximum: 1,
    },
  },
  required: ["type", "noul"],
  additionalProperties: false,
} as const satisfies DataPortSchemaNonBoolean;

const ChoiceAnswerSchema = {
  type: "object",
  properties: {
    type: { const: "choice" },
    choice: { type: "string", title: "Choice", description: "The highest-probability option" },
    probabilities: {
      type: "object",
      title: "Probabilities",
      description: "Every option mapped to its probability; the values sum to 1",
      additionalProperties: { type: "number" },
    },
    confidence: {
      type: "number",
      title: "Confidence",
      description: "How concentrated the distribution is, derived from the probabilities",
      minimum: 0,
      maximum: 1,
    },
  },
  required: ["type", "choice", "probabilities", "confidence"],
  additionalProperties: false,
} as const satisfies DataPortSchemaNonBoolean;

const ScoreAnswerSchema = {
  type: "object",
  properties: {
    type: { const: "score" },
    score: {
      type: "number",
      title: "Score",
      description: "Probability-weighted position across the levels; can land between them",
    },
    legend: {
      type: "object",
      title: "Legend",
      description: "Each level index, as a string key, mapped back to its description",
      additionalProperties: DescribedEntrySchema,
    },
    probabilities: {
      type: "object",
      title: "Probabilities",
      description: "Each level index mapped to its probability; the values sum to 1",
      additionalProperties: { type: "number" },
    },
    confidence: {
      type: "number",
      title: "Confidence",
      description: "How concentrated the distribution is, derived from the probabilities",
      minimum: 0,
      maximum: 1,
    },
  },
  required: ["type", "score", "legend", "probabilities", "confidence"],
  additionalProperties: false,
} as const satisfies DataPortSchemaNonBoolean;

const AnswerSchema = {
  oneOf: [NoulAnswerSchema, ChoiceAnswerSchema, ScoreAnswerSchema],
  title: "Answer",
  description: "One typed answer, discriminated by the `type` of the question it answers",
} as const satisfies DataPortSchemaNonBoolean;

export const SystemOneInputSchema = {
  type: "object",
  properties: {
    state: {
      ...EntrySchema,
      title: "State",
      description:
        "The content to evaluate: plain text, or a structured record when the context has several named parts",
    },
    questions: {
      type: "object",
      title: "Questions",
      description:
        "Questions keyed by a name you choose. The name is not sent to the model — it is how your code finds the answer, which comes back under the same key.",
      additionalProperties: QuestionSchema,
      minProperties: 1,
    },
    model: modelSchema,
  },
  required: ["state", "questions", "model"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export const SystemOneOutputSchema = {
  type: "object",
  properties: {
    answers: {
      type: "object",
      title: "Answers",
      description: "One answer per question, under the same key the question was asked under",
      additionalProperties: AnswerSchema,
    },
  },
  required: ["answers"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

/** Text, or a JSON object or array, wherever a question accepts prose or structure. */
export type SystemOneEntry = string | { [key: string]: unknown } | unknown[];

export type SystemOneNoulQuestion = {
  type: "noul";
  instructions: SystemOneEntry;
  criteria?: { true?: SystemOneEntry | undefined; false?: SystemOneEntry | undefined } | undefined;
};

export type SystemOneChoiceQuestion = {
  type: "choice";
  instructions: SystemOneEntry;
  criteria: { [option: string]: SystemOneEntry | null };
};

export type SystemOneScoreQuestion = {
  type: "score";
  instructions: SystemOneEntry;
  criteria: (SystemOneEntry | null)[];
};

export type SystemOneQuestion =
  | SystemOneNoulQuestion
  | SystemOneChoiceQuestion
  | SystemOneScoreQuestion;

export type SystemOneNoulAnswer = { type: "noul"; noul: number };

export type SystemOneChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: { [option: string]: number };
  confidence: number;
};

export type SystemOneScoreAnswer = {
  type: "score";
  score: number;
  legend: { [level: string]: SystemOneEntry | null };
  probabilities: { [level: string]: number };
  confidence: number;
};

export type SystemOneAnswer = SystemOneNoulAnswer | SystemOneChoiceAnswer | SystemOneScoreAnswer;

export type SystemOneTaskInput = {
  model: string | ModelConfig;
  state: SystemOneEntry;
  questions: { [name: string]: SystemOneQuestion };
};
export type SystemOneTaskOutput = { answers: { [name: string]: SystemOneAnswer } };
export type SystemOneTaskConfig = TaskConfig<SystemOneTaskInput>;

/**
 * Evaluates one `state` against a map of named, typed questions and returns a
 * typed answer for each.
 *
 * The answers are judgments, not generated text: a Noul is the probability that
 * a yes/no question is a yes, a Choice carries the selected option alongside the
 * probability of every option, and a Score is a probability-weighted position on
 * a rubric you define. Choice and Score also carry a `confidence`, which
 * summarises how concentrated the distribution is — it says whether to act on
 * the answer, not whether the answer is correct.
 *
 * **Ask every independent question of the same state in one run.** The provider
 * ingests the state once and evaluates the questions against it in parallel, so
 * one task asking eight questions costs a fraction of eight tasks asking one.
 * Speculative questions are fine — state each premise in the question itself and
 * let the graph read only the answers whose branch was taken. A second run is
 * warranted only when an answer decides what evidence to fetch next.
 *
 * A typed answer guarantees the shape of the result, never its truth.
 */
export class SystemOneTask extends AiTask<
  SystemOneTaskInput,
  SystemOneTaskOutput,
  SystemOneTaskConfig
> {
  public static override type = "SystemOneTask";
  /** Capabilities required of the model; gated in {@link AiTask.execute}. */
  public static override readonly requires = ["judgment.systemone"] as const satisfies Capability[];
  public static override category = "AI Text";
  public static override title = "System One";
  public static override description =
    "Evaluates state against named typed questions (choice / score / noul) and returns one typed answer per question, with probabilities and confidence.";
  public static override inputSchema(): DataPortSchema {
    return SystemOneInputSchema as DataPortSchema;
  }
  public static override outputSchema(): DataPortSchema {
    return SystemOneOutputSchema as DataPortSchema;
  }
}

export const systemOne = (
  input: SystemOneTaskInput,
  config?: SystemOneTaskConfig,
  runConfig?: Partial<IRunConfig>
) => {
  return new SystemOneTask(config).run(input, runConfig);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    systemOne: CreateWorkflow<SystemOneTaskInput, SystemOneTaskOutput, SystemOneTaskConfig>;
  }
}

Workflow.prototype.systemOne = CreateWorkflow(SystemOneTask);
