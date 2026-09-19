/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  TextClassificationTaskInput,
  TextClassificationTaskOutput,
} from "@workglow/ai";
import type { TypeSafeChoiceAnswer } from "./TypeSafeAi_Client";
import { getClient, getModelName } from "./TypeSafeAi_Client";
import type { TypeSafeAiModelConfig } from "./TypeSafeAi_ModelSchema";
import { mapTypeSafeAiUsage } from "./TypeSafeAi_Usage";

/** The key the single Choice question is asked and answered under. */
const QUESTION_ID = "label";

const INSTRUCTIONS = "Which of these labels best describes the text?";

/**
 * Turn the caller's label list into a Choice `criteria` map.
 *
 * Every label is sent undescribed (`null`): the task's port carries names, not
 * rubrics, and inventing a description for a label the caller did not describe
 * would change what is being asked.
 *
 * A blank label is refused rather than sent. `criteria` is keyed by label, so an
 * empty or whitespace-only key is not a malformed label but a value the caller
 * did not mean — most often an empty slot in a list — and the model has no way
 * to return it meaningfully. Duplicates collapse into one key on the way to a
 * map, so they are refused too: silently classifying against four labels when
 * five were named reports a distribution over a set the caller never chose.
 */
function buildCriteria(labels: readonly string[]): Record<string, null> {
  const criteria: Record<string, null> = {};
  for (const label of labels) {
    if (typeof label !== "string" || label.trim() === "") {
      throw new Error(
        "TypeSafe classification labels must be non-empty strings; `candidateLabels` contains a blank entry."
      );
    }
    if (Object.hasOwn(criteria, label)) {
      throw new Error(
        `TypeSafe classification labels must be distinct; "${label}" appears more than once in candidateLabels.`
      );
    }
    criteria[label] = null;
  }
  return criteria;
}

/**
 * One-shot run-fn for `["text.classification"]`.
 *
 * TypeSafe classifies by asking one Choice question over a label set the caller
 * supplies, so this is always the zero-shot path — there is no trained label
 * vocabulary to fall back on and `candidateLabels` is required rather than
 * optional. The answer's `probabilities` map is the score per label; they sum
 * to 1 and every label the caller named appears, which is what lets the sort
 * below rank the full set rather than only a top-1 the model happened to name.
 *
 * `maxCategories` truncates the ranked list. It is applied here rather than by
 * the caller so a large label set does not ship its whole tail through the port.
 */
export const TypeSafeAi_TextClassification_Stream: AiProviderRunFn<
  TextClassificationTaskInput,
  TextClassificationTaskOutput,
  TypeSafeAiModelConfig
> = async (input, model, signal, emit) => {
  const labels = input.candidateLabels;
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new Error(
      "TypeSafe classification is zero-shot against a caller-supplied label set: TextClassificationTask requires candidateLabels."
    );
  }
  const criteria = buildCriteria(labels);

  signal.throwIfAborted();
  const client = await getClient(model);
  const result = await client.systemOne(
    {
      state: input.text,
      questions: { [QUESTION_ID]: { type: "choice", instructions: INSTRUCTIONS, criteria } },
      model: getModelName(model),
    },
    { signal }
  );

  const answer = result.answers[QUESTION_ID];
  if (answer?.type !== "choice") {
    throw new Error(
      `TypeSafe returned a "${answer?.type ?? "missing"}" answer for a choice question.`
    );
  }

  const categories = rankCategories(answer, labels);
  const limit = typeof input.maxCategories === "number" ? input.maxCategories : undefined;

  emit({
    type: "finish",
    data: { categories: limit === undefined ? categories : categories.slice(0, limit) },
    usage: mapTypeSafeAiUsage(result.usage),
  });
};

/**
 * Rank the caller's labels by the probability the model gave each one.
 *
 * Iteration is over the caller's list, not the returned map, so the output
 * covers exactly the labels that were asked about and stays in a deterministic
 * order for ties. A label the response omits scores 0 — it was in the question,
 * so it has a probability, and dropping it would shorten a list the caller sized
 * with `maxCategories`.
 */
function rankCategories(
  answer: TypeSafeChoiceAnswer,
  labels: readonly string[]
): { label: string; score: number }[] {
  return labels
    .map((label) => ({ label, score: answer.probabilities[label] ?? 0 }))
    .sort((a, b) => b.score - a.score);
}
