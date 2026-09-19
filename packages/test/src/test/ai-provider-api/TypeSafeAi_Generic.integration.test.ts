/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, ModelSearchTaskOutput } from "@workglow/ai";
import {
  getGlobalModelRepository,
  InMemoryModelRepository,
  setGlobalModelRepository,
  SystemOneTask,
  TextClassificationTask,
  TextRerankerTask,
} from "@workglow/ai";
import { _testOnly } from "@workglow/typesafeai/ai";
import { setTaskQueueRegistry } from "@workglow/task-graph";
import { setLogger } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { TYPESAFEAI } from "@workglow/typesafeai/ai";
import { registerTypeSafeAiInline } from "@workglow/typesafeai/ai-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = !!process.env.TYPESAFE_API_KEY;
const MODEL_ID = "typesafe:jev-latest";

/**
 * Live coverage for the TypeSafe provider.
 *
 * `runAiProviderConformance` is not used here: every assertion in it is about
 * generating text, calling a tool or emitting JSON, and Jev does none of those.
 * What is worth spending a live call on is the three surfaces this provider
 * does serve, and the properties that only a real model can demonstrate — that
 * a probability distribution sums to 1 over the options that were asked about,
 * and that the answers come back under the caller's own keys.
 */
describe.skipIf(!RUN)("TypeSafe (live)", () => {
  beforeAll(async () => {
    setLogger(getTestingLogger());
    await setTaskQueueRegistry(null);
    setGlobalModelRepository(new InMemoryModelRepository());
    await registerTypeSafeAiInline();
    await getGlobalModelRepository().addModel({
      model_id: MODEL_ID,
      title: "Jev",
      description: "TypeSafe System One",
      capabilities: [
        "judgment.systemone",
        "text.classification",
        "text.reranking",
        "model.search",
        "model.info",
      ],
      provider: TYPESAFEAI as typeof TYPESAFEAI,
      provider_config: { model_name: "jev-latest" },
      metadata: {},
    });
  });

  afterAll(async () => {
    await setTaskQueueRegistry(null);
  });

  it("answers a noul, a choice and a score over one state in a single call", async () => {
    const out = await new SystemOneTask().run({
      model: MODEL_ID,
      state: { ticket: "I was charged twice and my payouts have failed for 3 days. Fix it now." },
      questions: {
        urgent: {
          type: "noul",
          instructions: "Does this convey urgency?",
          criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" },
        },
        department: {
          type: "choice",
          instructions: "Which team should handle this?",
          criteria: {
            billing: "Payments, invoicing, refunds",
            technical: "Bugs, outages, integrations",
            sales: "Pricing, upgrades, new accounts",
          },
        },
        frustration: {
          type: "score",
          instructions: "How frustrated is the customer?",
          criteria: ["Calm", "Frustrated", "Very angry"],
        },
      },
    });

    expect(Object.keys(out!.answers).sort()).toEqual(["department", "frustration", "urgent"]);

    const urgent = out!.answers.urgent as { type: string; noul: number };
    expect(urgent.type).toBe("noul");
    expect(urgent.noul).toBeGreaterThan(0.5);

    const department = out!.answers.department as {
      type: string;
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    };
    expect(department.type).toBe("choice");
    expect(["billing", "technical"]).toContain(department.choice);
    expect(Object.keys(department.probabilities).sort()).toEqual(["billing", "sales", "technical"]);
    const total = Object.values(department.probabilities).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 2);
    expect(department.confidence).toBeGreaterThanOrEqual(0);
    expect(department.confidence).toBeLessThanOrEqual(1);

    const frustration = out!.answers.frustration as {
      type: string;
      score: number;
      legend: Record<string, unknown>;
    };
    expect(frustration.type).toBe("score");
    expect(frustration.score).toBeGreaterThanOrEqual(0);
    expect(frustration.score).toBeLessThanOrEqual(2);
    expect(Object.keys(frustration.legend).sort()).toEqual(["0", "1", "2"]);
  }, 30_000);

  it("classifies against caller-supplied labels", async () => {
    const out = await new TextClassificationTask().run({
      model: MODEL_ID,
      text: "My card was charged twice for the same invoice.",
      candidateLabels: ["billing", "technical", "sales"],
    });

    expect(out!.categories).toHaveLength(3);
    expect(out!.categories[0]!.label).toBe("billing");
    const total = out!.categories.reduce((sum, c) => sum + c.score, 0);
    expect(total).toBeCloseTo(1, 2);
  }, 30_000);

  it("reranks a shortlist so the passage that answers the query comes first", async () => {
    const documents = [
      "The office cafeteria serves lunch from 11am.",
      "To reset your password, open Settings and choose Security, then Reset password.",
      "Our Q3 revenue grew twelve percent year over year.",
    ];

    const out = await new TextRerankerTask().run({
      model: MODEL_ID,
      query: "How do I reset my password?",
      documents,
      topK: 2,
    });

    expect(out!.scores).toHaveLength(3);
    expect(out!.indices).toHaveLength(2);
    expect(out!.indices[0]).toBe(1);
  }, 60_000);

  /**
   * The one thing a mocked transport cannot check: `GET /v1/models` answers
   * `{"models": [...]}` on the wire, and the SDK unwraps it to a bare array
   * before handing it back. The provider reads it as an array, so a mock that
   * returns one agrees with the provider whether or not the SDK does.
   *
   * It also pins the curated fallback against what the vendor actually says, so
   * the keyless and keyed paths cannot describe the same model two ways.
   */
  it("lists the account's models, unwrapped by the SDK to a bare array", async () => {
    const runFn = _testOnly.TYPESAFEAI_RUN_FNS.find(({ serves }) =>
      (serves as readonly string[]).includes("model.search")
    )!.runFn as AiProviderRunFn;

    let live: ModelSearchTaskOutput | undefined;
    await runFn(
      { provider: TYPESAFEAI, credential_key: process.env.TYPESAFE_API_KEY },
      undefined as never,
      new AbortController().signal,
      (ev) => {
        if (ev.type === "finish") live = ev.data as ModelSearchTaskOutput;
      }
    );

    expect(live!.results.map((r) => r.id)).toEqual(["jev-latest", "jev-preview"]);
    for (const result of live!.results) {
      expect(result.description.length).toBeGreaterThan(0);
      expect(result.record.provider).toBe(TYPESAFEAI);
      expect(result.record.capabilities).toEqual([]);
    }

    let fallback: ModelSearchTaskOutput | undefined;
    await runFn(
      { provider: TYPESAFEAI },
      undefined as never,
      new AbortController().signal,
      (ev) => {
        if (ev.type === "finish") fallback = ev.data as ModelSearchTaskOutput;
      }
    );

    expect(fallback!.results.map((r) => r.id)).toEqual(live!.results.map((r) => r.id));
    expect(fallback!.results.map((r) => r.description)).toEqual(
      live!.results.map((r) => r.description)
    );
  }, 30_000);
});
