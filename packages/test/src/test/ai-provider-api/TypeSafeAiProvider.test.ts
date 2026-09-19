/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelRecord } from "@workglow/ai";
import {
  _testOnly,
  getTypeSafeAiModelPricing,
  resolveRerankConcurrency,
  TYPESAFEAI_ALLOWED_HOSTS,
  TYPESAFEAI_DEFAULT_BASE_URL,
  TYPESAFEAI_DEFAULT_RERANK_CONCURRENCY,
} from "@workglow/typesafeai/ai";
import { describe, expect, it } from "vitest";

const { TypeSafeAiQueuedProvider, TYPESAFEAI_RUN_FN_SPECS, TYPESAFEAI_RUN_FNS } = _testOnly;

function model(model_id: string, capabilities: readonly string[] = []): ModelRecord {
  return {
    model_id,
    title: model_id,
    description: "",
    provider: "TYPESAFEAI",
    provider_config: { model_name: model_id },
    capabilities: [...capabilities],
    metadata: {},
  } as ModelRecord;
}

describe("TypeSafeAiQueuedProvider.inferCapabilities", () => {
  const provider = new TypeSafeAiQueuedProvider(TYPESAFEAI_RUN_FNS);

  it("infers the System One surface for the jev family and its aliases", () => {
    for (const id of ["jev-latest", "jev-preview", "jev-1.13.0"]) {
      const caps = provider.inferCapabilities(model(id));
      expect(caps).toContain("judgment.systemone");
      expect(caps).toContain("text.classification");
      expect(caps).toContain("text.reranking");
    }
  });

  // The whole point of a System One model is that it returns judgments rather
  // than prose. A record claiming otherwise would clear the task's capability
  // gate and fail inside the provider instead, with the useful message gone.
  it("never infers generation, tools, json-mode, embeddings or images", () => {
    const caps = provider.inferCapabilities(model("jev-latest"));
    for (const absent of [
      "text.generation",
      "tool-use",
      "json-mode",
      "text.embedding",
      "image.generation",
      "vision-input",
      "model.count-tokens",
    ]) {
      expect(caps).not.toContain(absent);
    }
  });

  it("infers the full capability set for jev-latest", () => {
    const sorted = [...provider.inferCapabilities(model("jev-latest"))].sort();
    expect(sorted).toEqual([
      "judgment.systemone",
      "model.info",
      "model.search",
      "text.classification",
      "text.reranking",
    ]);
  });

  it("falls back to declared capabilities when the model id is unknown", () => {
    const caps = provider.inferCapabilities(model("some-other-model", ["text.classification"]));
    expect(caps).toEqual(["text.classification"]);
  });

  it("falls back to a baseline of meta-ops when nothing matches and nothing is declared", () => {
    const caps = provider.inferCapabilities(model("some-other-model"));
    expect(caps).toContain("model.search");
    expect(caps).toContain("model.info");
    expect(caps).not.toContain("judgment.systemone");
  });
});

describe("capability-set parity", () => {
  it("TYPESAFEAI_RUN_FN_SPECS matches TYPESAFEAI_RUN_FNS serves shapes", () => {
    const fnsServes = TYPESAFEAI_RUN_FNS.map((r) => [...r.serves].sort().join(","));
    const specsServes = TYPESAFEAI_RUN_FN_SPECS.map((s) => [...s.serves].sort().join(","));
    expect(specsServes).toEqual(fnsServes);
  });
});

describe("TYPESAFEAI_RUN_FNS shape", () => {
  it("registers a runFn for every capability set the provider claims to serve", () => {
    const sets = TYPESAFEAI_RUN_FNS.map((r) => [...r.serves].sort().join(","));
    expect(sets).toEqual([
      "judgment.systemone",
      "text.classification",
      "text.reranking",
      "model.search",
      "model.info",
    ]);
  });

  // Every entry is a single-capability set, so the dispatcher's
  // most-specific-wins tiebreak never has to choose between two of them.
  it("serves each capability from exactly one single-capability set", () => {
    for (const registration of TYPESAFEAI_RUN_FNS) {
      expect(registration.serves).toHaveLength(1);
    }
    const all = TYPESAFEAI_RUN_FNS.flatMap((r) => [...r.serves]);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("base URL", () => {
  it("defaults to the documented TypeSafe host, which is also the only allow-listed one", () => {
    expect(TYPESAFEAI_DEFAULT_BASE_URL).toBe("https://api.typesafe.ai");
    expect(TYPESAFEAI_ALLOWED_HOSTS).toEqual(["api.typesafe.ai"]);
    expect(TYPESAFEAI_ALLOWED_HOSTS).toContain(new URL(TYPESAFEAI_DEFAULT_BASE_URL).hostname);
  });
});

describe("pricing", () => {
  // $42 per billion input tokens is $0.042 per million, the unit every card
  // in the repo is quoted in. Output is a STATED zero — TypeSafe gives output
  // tokens away — not an unreported rate.
  it("prices jev per 1M input tokens with free output", () => {
    const card = getTypeSafeAiModelPricing("jev-latest");
    expect(card).toEqual({ currency: "USD", input: 0.042, output: 0 });
  });

  it("prices the aliases and the pinned version the same", () => {
    for (const id of ["jev-latest", "jev-preview", "jev-1.13.0"]) {
      expect(getTypeSafeAiModelPricing(id)).toEqual(getTypeSafeAiModelPricing("jev-latest"));
    }
  });

  // A dot is not a suffix boundary in the table walk, so the bare `jev` key is
  // what carries a point release the table has not been updated for.
  it("carries a future point release on the bare jev key", () => {
    expect(getTypeSafeAiModelPricing("jev-1.14.0")).toEqual({
      currency: "USD",
      input: 0.042,
      output: 0,
    });
  });

  it("leaves a model the table does not name unpriced", () => {
    expect(getTypeSafeAiModelPricing("gpt-4o")).toBeUndefined();
    expect(getTypeSafeAiModelPricing(undefined)).toBeUndefined();
  });
});

describe("resolveRerankConcurrency", () => {
  const withConcurrency = (rerank_concurrency: unknown) =>
    ({ provider_config: { model_name: "jev-latest", rerank_concurrency } }) as never;

  it("defaults when the model configures nothing", () => {
    expect(resolveRerankConcurrency(undefined)).toBe(TYPESAFEAI_DEFAULT_RERANK_CONCURRENCY);
    expect(
      resolveRerankConcurrency({ provider_config: { model_name: "jev-latest" } } as never)
    ).toBe(TYPESAFEAI_DEFAULT_RERANK_CONCURRENCY);
  });

  it("honours a configured bound", () => {
    expect(resolveRerankConcurrency(withConcurrency(3))).toBe(3);
  });

  // A bound of zero would stall the fan-out forever rather than slow it down,
  // so a value that says nothing usable leaves the default standing.
  it("ignores a non-positive or non-finite bound rather than stalling the run", () => {
    expect(resolveRerankConcurrency(withConcurrency(0))).toBe(
      TYPESAFEAI_DEFAULT_RERANK_CONCURRENCY
    );
    expect(resolveRerankConcurrency(withConcurrency(-5))).toBe(
      TYPESAFEAI_DEFAULT_RERANK_CONCURRENCY
    );
    expect(resolveRerankConcurrency(withConcurrency(Number.NaN))).toBe(
      TYPESAFEAI_DEFAULT_RERANK_CONCURRENCY
    );
    expect(resolveRerankConcurrency(withConcurrency("8"))).toBe(
      TYPESAFEAI_DEFAULT_RERANK_CONCURRENCY
    );
  });

  it("floors a fractional bound", () => {
    expect(resolveRerankConcurrency(withConcurrency(4.7))).toBe(4);
  });
});
