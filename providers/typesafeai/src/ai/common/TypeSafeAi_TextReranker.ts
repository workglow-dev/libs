/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  TextRerankerTaskInput,
  TextRerankerTaskOutput,
  Usage,
} from "@workglow/ai";
import { KbRerankerOutputError } from "@workglow/ai";
import type { TypeSafeClientLike } from "./TypeSafeAi_Client";
import { getClient, getModelName, resolveRerankConcurrency } from "./TypeSafeAi_Client";
import type { TypeSafeAiModelConfig } from "./TypeSafeAi_ModelSchema";
import { addTypeSafeAiUsage, mapTypeSafeAiUsage } from "./TypeSafeAi_Usage";

/** The key the single Noul question is asked and answered under. */
const QUESTION_ID = "answers_query";

const INSTRUCTIONS = "Does this candidate answer the query?";

const CRITERIA = {
  true: "The candidate contains what the query is asking for.",
  false: "The candidate is unrelated, or is only on a similar topic.",
} as const;

/**
 * Score one candidate against the query.
 *
 * The query and the candidate go in together as named state fields so the
 * question can talk about the relationship between them; the question itself is
 * the same for every candidate, which is what makes the returned nouls
 * comparable across the shortlist.
 */
async function scoreCandidate(
  client: TypeSafeClientLike,
  modelName: string,
  query: string,
  candidate: string,
  signal: AbortSignal
): Promise<{ readonly score: number; readonly usage: Usage | undefined }> {
  const result = await client.systemOne(
    {
      state: { query, candidate },
      questions: {
        [QUESTION_ID]: { type: "noul", instructions: INSTRUCTIONS, criteria: CRITERIA },
      },
      model: modelName,
    },
    { signal }
  );

  const answer = result.answers[QUESTION_ID];
  if (answer?.type !== "noul" || typeof answer.noul !== "number") {
    throw new KbRerankerOutputError(
      `TypeSafe returned no noul for a rerank candidate (model ${modelName})`,
      JSON.stringify(answer ?? null).slice(0, 200)
    );
  }
  return { score: answer.noul, usage: mapTypeSafeAiUsage(result.usage) };
}

/**
 * One-shot run-fn for `["text.reranking"]`.
 *
 * Each candidate is scored by its own request, which is what the vendor's own
 * recipe does and what keeps the scores independent: batching the shortlist
 * into one call would put every candidate in the state each question reads, so
 * a passage's score would depend on what it was ranked beside. The cost is a
 * fan-out — N candidates are N requests — so it runs `concurrency` at a time
 * rather than all at once, bounded against the account's requests-per-minute
 * limit. The SDK backs off and retries a 429 within each request.
 *
 * `scores` comes back in the caller's original document order so a caller can
 * join it against its own candidate list; `indices` is sorted best-first and
 * truncated to `topK`.
 *
 * Usage is the sum across every request. One request's counters would understate
 * the run by the size of the shortlist.
 */
export const TypeSafeAi_TextReranker_Stream: AiProviderRunFn<
  TextRerankerTaskInput,
  TextRerankerTaskOutput,
  TypeSafeAiModelConfig
> = async (input, model, signal, emit) => {
  const documents = input.documents ?? [];
  if (documents.length === 0) {
    emit({ type: "finish", data: { scores: [], indices: [] } });
    return;
  }

  signal.throwIfAborted();
  const client = await getClient(model);
  const modelName = getModelName(model);
  const concurrency = Math.min(resolveRerankConcurrency(model), documents.length);

  const scores = new Array<number>(documents.length);
  let usage: Usage | undefined;

  // A shared cursor rather than a chunked loop: a slow candidate in one chunk
  // would otherwise hold the whole chunk's slot open while later candidates
  // wait on it.
  //
  // `stop` is what keeps a failure from being paid for N times. `Promise.all`
  // rejects on the first throw but does not stop the other workers, and they
  // are looping over a cursor — without this they would score every remaining
  // candidate, billing the whole shortlist for a run whose result is already
  // thrown away.
  let next = 0;
  let stop = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (stop) return;
      const index = next++;
      if (index >= documents.length) return;
      signal.throwIfAborted();
      try {
        const scored = await scoreCandidate(
          client,
          modelName,
          input.query,
          documents[index]!,
          signal
        );
        scores[index] = scored.score;
        usage = addTypeSafeAiUsage(usage, scored.usage);
      } catch (err) {
        stop = true;
        throw err;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  const indices = scores
    .map((score, idx) => ({ score, idx }))
    .sort((a, b) => b.score - a.score)
    .map((pair) => pair.idx);
  const limited = typeof input.topK === "number" ? indices.slice(0, input.topK) : indices;

  emit({ type: "finish", data: { scores, indices: limited }, usage });
};
