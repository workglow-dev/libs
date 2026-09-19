/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, TextRerankerTaskOutput } from "@workglow/ai";
import { _testOnly, TYPESAFEAI } from "@workglow/typesafeai/ai";
import { _testOnly as runtimeTestOnly } from "@workglow/typesafeai/ai-runtime";
import { afterEach, describe, expect, it } from "vitest";

const { TYPESAFEAI_RUN_FNS, setTypeSafeAiClientForTests } = _testOnly;

function rerankRunFn(): AiProviderRunFn {
  const registration = TYPESAFEAI_RUN_FNS.find(({ serves }) =>
    (serves as readonly string[]).includes("text.reranking")
  );
  expect(registration).toBeDefined();
  return registration!.runFn as AiProviderRunFn;
}

const modelConfig = (rerank_concurrency?: number) =>
  ({
    model_id: "jev-latest",
    title: "jev-latest",
    description: "",
    provider: TYPESAFEAI,
    provider_config: { model_name: "jev-latest", api_key: "test-key", rerank_concurrency },
    capabilities: ["text.reranking"],
    metadata: {},
  }) as never;

interface Recorded {
  readonly state: { query: string; candidate: string };
  readonly questions: Record<string, { type: string; instructions?: unknown; criteria?: unknown }>;
}

interface Harness {
  readonly requests: Recorded[];
  /** Highest number of requests in flight at the same moment. */
  peakInFlight(): number;
}

/**
 * Install a client that scores each candidate by a caller-supplied function and
 * tracks how many requests overlap, which is what the concurrency bound is
 * about.
 */
function installClient(
  score: (candidate: string) => number | Promise<number>,
  opts: { readonly deferred?: boolean } = {}
): Harness {
  const requests: Recorded[] = [];
  let inFlight = 0;
  let peak = 0;

  const client = {
    systemOne: async (request: Recorded) => {
      requests.push(request);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        if (opts.deferred) await new Promise((resolve) => setTimeout(resolve, 0));
        const noul = await score(request.state.candidate);
        return {
          model: "jev-1.13.0",
          answers: { answers_query: { type: "noul", noul } },
          usage: { input_tokens: 10, output_tokens: 2 },
        };
      } finally {
        inFlight -= 1;
      }
    },
    models: { list: async () => [] },
  };
  setTypeSafeAiClientForTests(client as never);
  runtimeTestOnly.setTypeSafeAiClientForTests?.(client as never);
  return { requests, peakInFlight: () => peak };
}

async function rerank(
  input: Record<string, unknown>,
  concurrency?: number
): Promise<{ data: TextRerankerTaskOutput; usage: unknown }> {
  const model = modelConfig(concurrency);
  let data: TextRerankerTaskOutput | undefined;
  let usage: unknown;
  await rerankRunFn()({ model, ...input }, model, new AbortController().signal, (ev) => {
    if (ev.type === "finish") {
      data = ev.data as TextRerankerTaskOutput;
      usage = ev.usage;
    }
  });
  return { data: data!, usage };
}

const SCORES: Record<string, number> = { alpha: 0.2, bravo: 0.9, charlie: 0.5 };

describe("TypeSafeAi_TextReranker", () => {
  afterEach(() => {
    setTypeSafeAiClientForTests(undefined);
    runtimeTestOnly.setTypeSafeAiClientForTests?.(undefined);
  });

  // Batching the shortlist into one call would put every candidate in the state
  // each question reads, so a passage's score would depend on what it was
  // ranked beside. One request per candidate is what keeps them independent.
  it("scores each candidate in its own request, with only that candidate in state", async () => {
    const harness = installClient((c) => SCORES[c]!);

    await rerank({ query: "q", documents: ["alpha", "bravo", "charlie"] });

    expect(harness.requests).toHaveLength(3);
    for (const request of harness.requests) {
      expect(request.state.query).toBe("q");
      expect(Object.keys(request.state).sort()).toEqual(["candidate", "query"]);
      expect(request.questions.answers_query!.type).toBe("noul");
    }
    expect(harness.requests.map((r) => r.state.candidate)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("asks the same question of every candidate, so the nouls are comparable", async () => {
    const harness = installClient((c) => SCORES[c]!);

    await rerank({ query: "q", documents: ["alpha", "bravo"] });

    const [first, second] = harness.requests;
    expect(first!.questions.answers_query).toEqual(second!.questions.answers_query);
    expect(first!.questions.answers_query!.criteria).toBeDefined();
  });

  it("returns scores in the caller's document order and indices best-first", async () => {
    installClient((c) => SCORES[c]!);

    const { data } = await rerank({ query: "q", documents: ["alpha", "bravo", "charlie"] });

    expect(data.scores).toEqual([0.2, 0.9, 0.5]);
    expect(data.indices).toEqual([1, 2, 0]);
  });

  it("truncates indices to topK while leaving scores whole", async () => {
    installClient((c) => SCORES[c]!);

    const { data } = await rerank({
      query: "q",
      documents: ["alpha", "bravo", "charlie"],
      topK: 2,
    });

    expect(data.indices).toEqual([1, 2]);
    expect(data.scores).toHaveLength(3);
  });

  // One request's counters would understate the run by the size of the
  // shortlist, which is the whole cost of a fan-out rerank.
  it("sums usage across every request", async () => {
    installClient((c) => SCORES[c]!);

    const { usage } = await rerank({ query: "q", documents: ["alpha", "bravo", "charlie"] });

    expect(usage).toEqual({
      input: 30,
      output: 6,
      cached: undefined,
      cacheWrite: undefined,
      reasoning: undefined,
      total: undefined,
      extra: undefined,
    });
  });

  it("bounds the fan-out to the configured concurrency", async () => {
    const harness = installClient(() => 0.5, { deferred: true });

    await rerank({ query: "q", documents: ["a", "b", "c", "d", "e", "f"] }, 2);

    expect(harness.requests).toHaveLength(6);
    expect(harness.peakInFlight()).toBeLessThanOrEqual(2);
  });

  it("never opens more slots than there are candidates", async () => {
    const harness = installClient(() => 0.5, { deferred: true });

    await rerank({ query: "q", documents: ["a", "b"] }, 16);

    expect(harness.peakInFlight()).toBeLessThanOrEqual(2);
  });

  it("makes no request at all for an empty shortlist", async () => {
    const harness = installClient(() => 0.5);

    const { data } = await rerank({ query: "q", documents: [] });

    expect(data).toEqual({ scores: [], indices: [] });
    expect(harness.requests).toHaveLength(0);
  });

  // `Promise.all` rejects on the first throw but does not stop the other
  // workers, and they are looping over a shared cursor — without the stop flag
  // a failed rerank would still bill the whole shortlist.
  it("stops scoring the rest of the shortlist once one candidate fails", async () => {
    const harness = installClient((candidate) => {
      if (candidate === "a") throw new Error("boom");
      return 0.5;
    });

    const documents = Array.from({ length: 40 }, (_, i) => (i === 0 ? "a" : `doc-${i}`));
    await expect(rerank({ query: "q", documents }, 2)).rejects.toThrow("boom");

    expect(harness.requests.length).toBeLessThan(documents.length);
  });

  it("throws a reranker output error when TypeSafe returns no noul", async () => {
    const client = {
      systemOne: async () => ({
        model: "jev-1.13.0",
        answers: { answers_query: { type: "choice", choice: "yes" } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      models: { list: async () => [] },
    };
    setTypeSafeAiClientForTests(client as never);
    runtimeTestOnly.setTypeSafeAiClientForTests?.(client as never);

    await expect(rerank({ query: "q", documents: ["a"] })).rejects.toThrow(
      /no noul for a rerank candidate/i
    );
  });
});
