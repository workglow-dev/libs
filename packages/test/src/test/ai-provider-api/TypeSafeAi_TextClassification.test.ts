/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, TextClassificationTaskOutput } from "@workglow/ai";
import { _testOnly, TYPESAFEAI } from "@workglow/typesafeai/ai";
import { _testOnly as runtimeTestOnly } from "@workglow/typesafeai/ai-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { TYPESAFEAI_RUN_FNS, setTypeSafeAiClientForTests } = _testOnly;

function classificationRunFn(): AiProviderRunFn {
  const registration = TYPESAFEAI_RUN_FNS.find(({ serves }) =>
    (serves as readonly string[]).includes("text.classification")
  );
  expect(registration).toBeDefined();
  return registration!.runFn as AiProviderRunFn;
}

const modelConfig = () =>
  ({
    model_id: "jev-latest",
    title: "jev-latest",
    description: "",
    provider: TYPESAFEAI,
    provider_config: { model_name: "jev-latest", api_key: "test-key" },
    capabilities: ["text.classification"],
    metadata: {},
  }) as never;

interface Recorded {
  readonly state: unknown;
  readonly questions: Record<string, { type: string; criteria?: unknown }>;
}

function installClient(probabilities: Record<string, number>, sink: Recorded[]): void {
  const client = {
    systemOne: async (request: Recorded) => {
      sink.push(request);
      const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      return {
        model: "jev-1.13.0",
        answers: {
          label: { type: "choice", choice: best, probabilities, confidence: 0.8 },
        },
        usage: { input_tokens: 40, output_tokens: 4 },
      };
    },
    models: { list: async () => [] },
  };
  setTypeSafeAiClientForTests(client as never);
  runtimeTestOnly.setTypeSafeAiClientForTests?.(client as never);
}

async function classify(input: Record<string, unknown>): Promise<TextClassificationTaskOutput> {
  const model = modelConfig();
  let data: TextClassificationTaskOutput | undefined;
  await classificationRunFn()({ model, ...input }, model, new AbortController().signal, (ev) => {
    if (ev.type === "finish") data = ev.data as TextClassificationTaskOutput;
  });
  return data!;
}

describe("TypeSafeAi_TextClassification", () => {
  let requests: Recorded[];

  beforeEach(() => {
    requests = [];
  });

  afterEach(() => {
    setTypeSafeAiClientForTests(undefined);
    runtimeTestOnly.setTypeSafeAiClientForTests?.(undefined);
  });

  it("asks one Choice question whose options are the caller's labels, undescribed", async () => {
    installClient({ billing: 0.85, technical: 0.1, other: 0.05 }, requests);

    await classify({
      text: "I was charged twice.",
      candidateLabels: ["billing", "technical", "other"],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.state).toBe("I was charged twice.");
    const question = requests[0]!.questions.label!;
    expect(question.type).toBe("choice");
    // `null` per label: the port carries names, not rubrics, and inventing a
    // description would change what is being asked.
    expect(question.criteria).toEqual({ billing: null, technical: null, other: null });
  });

  it("returns every label ranked by probability, highest first", async () => {
    installClient({ billing: 0.85, technical: 0.1, other: 0.05 }, requests);

    const out = await classify({
      text: "x",
      candidateLabels: ["technical", "other", "billing"],
    });

    expect(out.categories).toEqual([
      { label: "billing", score: 0.85 },
      { label: "technical", score: 0.1 },
      { label: "other", score: 0.05 },
    ]);
  });

  it("truncates the ranked list to maxCategories", async () => {
    installClient({ a: 0.5, b: 0.3, c: 0.2 }, requests);

    const out = await classify({ text: "x", candidateLabels: ["a", "b", "c"], maxCategories: 2 });
    expect(out.categories.map((c) => c.label)).toEqual(["a", "b"]);
  });

  // The label was in the question, so it has a probability. Dropping it would
  // shorten a list the caller sized with maxCategories.
  it("scores a label the response omits as 0 rather than dropping it", async () => {
    installClient({ a: 1 }, requests);

    const out = await classify({ text: "x", candidateLabels: ["a", "b"] });
    expect(out.categories).toEqual([
      { label: "a", score: 1 },
      { label: "b", score: 0 },
    ]);
  });

  it("reports the token counts TypeSafe billed", async () => {
    installClient({ a: 1 }, requests);

    const model = modelConfig();
    let usage: unknown;
    await classificationRunFn()(
      { model, text: "x", candidateLabels: ["a"] },
      model,
      new AbortController().signal,
      (ev) => {
        if (ev.type === "finish") usage = ev.usage;
      }
    );
    expect((usage as { input?: number }).input).toBe(40);
  });

  // TypeSafe has no trained label vocabulary to fall back on, so the zero-shot
  // path is the only path.
  it("requires candidateLabels", async () => {
    installClient({ a: 1 }, requests);

    await expect(classify({ text: "x" })).rejects.toThrow(/candidateLabels/);
    await expect(classify({ text: "x", candidateLabels: [] })).rejects.toThrow(/candidateLabels/);
    expect(requests).toHaveLength(0);
  });

  // `criteria` is keyed by label, so a blank key is not a malformed label but a
  // value the caller did not mean, and a duplicate would silently classify
  // against a smaller set than was named.
  it("refuses a blank or duplicated label instead of collapsing the option set", async () => {
    installClient({ a: 1 }, requests);

    await expect(classify({ text: "x", candidateLabels: ["a", "  "] })).rejects.toThrow(
      /non-empty/i
    );
    await expect(classify({ text: "x", candidateLabels: ["a", "a"] })).rejects.toThrow(/distinct/i);
    expect(requests).toHaveLength(0);
  });

  // `candidateLabels` is an ordinary data port, so a label spelled "__proto__"
  // arrives from a dataflow or a graph JSON this package did not author. On a
  // plain object literal it would never become an own key, so the question
  // would be asked about two labels while three were named — and neither the
  // blank guard nor the distinctness guard would notice.
  it("sends a __proto__ label as its own criteria key rather than dropping it", async () => {
    installClient({ spam: 0.7, ham: 0.3 }, requests);

    await classify({ text: "x", candidateLabels: ["spam", "__proto__", "ham"] });

    expect(requests).toHaveLength(1);
    const criteria = requests[0]!.questions.label!.criteria as Record<string, null>;
    expect(Object.keys(criteria).sort()).toEqual(["__proto__", "ham", "spam"]);
    expect(Object.hasOwn(criteria, "__proto__")).toBe(true);
    expect(criteria.__proto__).toBeNull();
  });

  // `map["__proto__"] ?? 0` never fires its fallback: the inherited value is an
  // object, so a `score` port declared `number` would carry `{}` and every
  // comparison against it in the sort would be NaN.
  it("scores an omitted __proto__ label as the number 0, not an inherited object", async () => {
    installClient({ spam: 0.7, ham: 0.3 }, requests);

    const out = await classify({ text: "x", candidateLabels: ["spam", "__proto__", "ham"] });

    expect(out.categories).toEqual([
      { label: "spam", score: 0.7 },
      { label: "ham", score: 0.3 },
      { label: "__proto__", score: 0 },
    ]);
    expect(out.categories.map((c) => typeof c.score)).toEqual(["number", "number", "number"]);
  });

  // The distinctness guard reads own properties, so it only means what it says
  // once the map has no prototype to absorb the first assignment.
  it("refuses a duplicated __proto__ label the way it refuses any other", async () => {
    installClient({ spam: 1 }, requests);

    await expect(
      classify({ text: "x", candidateLabels: ["spam", "__proto__", "ham", "__proto__"] })
    ).rejects.toThrow(/distinct/i);
    expect(requests).toHaveLength(0);
  });

  it("throws when TypeSafe answers a choice question with another answer type", async () => {
    const client = {
      systemOne: async () => ({
        model: "jev-1.13.0",
        answers: { label: { type: "noul", noul: 0.4 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      models: { list: async () => [] },
    };
    setTypeSafeAiClientForTests(client as never);
    runtimeTestOnly.setTypeSafeAiClientForTests?.(client as never);

    await expect(classify({ text: "x", candidateLabels: ["a"] })).rejects.toThrow(
      /noul.*choice question/i
    );
  });
});
