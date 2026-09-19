/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, SystemOneTaskInput, SystemOneTaskOutput } from "@workglow/ai";
import type { TypeSafeQuestion } from "./TypeSafeAi_Client";
import { getClient, getModelName } from "./TypeSafeAi_Client";
import type { TypeSafeAiModelConfig } from "./TypeSafeAi_ModelSchema";
import { mapTypeSafeAiUsage } from "./TypeSafeAi_Usage";

/**
 * One-shot run-fn for `["judgment.systemone"]` — the provider's native surface.
 *
 * The task's ports are already the wire shape, so this forwards them rather
 * than translating: the question map goes out under the caller's own keys and
 * the answers come back under the same ones. The model ingests the state once
 * and evaluates every question against it in parallel, which is why asking
 * eight questions here costs a fraction of running the task eight times.
 *
 * A request with no questions is refused before the call: the API rejects it,
 * and paying a round trip to be told so loses the run's own vocabulary for
 * saying what was wrong.
 */
export const TypeSafeAi_SystemOne_Stream: AiProviderRunFn<
  SystemOneTaskInput,
  SystemOneTaskOutput,
  TypeSafeAiModelConfig
> = async (input, model, signal, emit) => {
  const questions = input.questions;
  const names = questions ? Object.keys(questions) : [];
  if (names.length === 0) {
    throw new Error("SystemOneTask requires at least one question; `questions` was empty.");
  }

  signal.throwIfAborted();
  const client = await getClient(model);
  const result = await client.systemOne(
    {
      state: input.state,
      questions: questions as Readonly<Record<string, TypeSafeQuestion>>,
      model: getModelName(model),
    },
    { signal }
  );

  emit({
    type: "finish",
    data: { answers: result.answers as SystemOneTaskOutput["answers"] },
    usage: mapTypeSafeAiUsage(result.usage),
  });
};
