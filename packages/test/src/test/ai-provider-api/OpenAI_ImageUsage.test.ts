/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, ModelPricing } from "@workglow/ai";
import { estimateCost, formatCost } from "@workglow/ai";
import { OPENAI, _testOnly, getOpenAiModelPricing } from "@workglow/openai/ai";
import { _testOnly as runtimeTestOnly } from "@workglow/openai/ai-runtime";
import type { StreamEvent, Usage } from "@workglow/task-graph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { OPENAI_RUN_FNS, setOpenAIClientForTests } = _testOnly;

function findRunFn(capability: string): AiProviderRunFn {
  const registration = OPENAI_RUN_FNS.find(({ serves }) =>
    (serves as readonly string[]).includes(capability)
  );
  expect(registration, `no OpenAI run-fn serves ${capability}`).toBeDefined();
  return registration!.runFn as AiProviderRunFn;
}

const modelConfig = (modelName: string) =>
  ({
    model_id: modelName,
    title: modelName,
    description: "",
    provider: OPENAI,
    provider_config: { model_name: modelName, api_key: "test-key" },
    capabilities: ["image.generation", "image.editing"],
    metadata: {},
  }) as never;

/** A 1x1 PNG, small enough to decode in-process. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

/**
 * What the Images API reports on the terminal event: one prompt total plus a
 * disjoint `text_tokens` / `image_tokens` split of it. Every figure here is
 * OpenAI's own — an image edit's prompt is mostly the input image.
 */
const IMAGE_USAGE = {
  input_tokens: 1560,
  output_tokens: 1056,
  total_tokens: 2616,
  input_tokens_details: { text_tokens: 60, image_tokens: 1500 },
};

function imageStream(usage: unknown): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { b64_json: PNG_B64, type: "image_generation.partial_image" };
      yield { b64_json: PNG_B64, type: "image_generation.completed", usage };
    },
  };
}

async function drive(
  runFn: AiProviderRunFn,
  input: Record<string, unknown>,
  modelName: string
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  await runFn(input as never, modelConfig(modelName), new AbortController().signal, (event) =>
    events.push(event as StreamEvent)
  );
  return events;
}

function finishUsage(events: readonly StreamEvent[]): Usage | undefined {
  const finish = events.find((event) => event.type === "finish");
  expect(finish, "the run-fn emitted no finish event").toBeDefined();
  return (finish as { usage?: Usage }).usage;
}

/**
 * GPT Image bills a prompt over three rates — text input $5, image input $8,
 * image output $30 — so a run that reports only `input_tokens` prices its whole
 * prompt at the text rate. The run-fns exist to put the provider's own split on
 * the wire, which is the only thing that makes the image rows on the card
 * reachable.
 */
describe("OpenAI image run-fns report the prompt's image split", () => {
  let requested: Record<string, unknown>[];

  beforeEach(() => {
    requested = [];
    const fakeClient = {
      images: {
        generate: async (body: Record<string, unknown>) => {
          requested.push(body);
          if (String(body.model).startsWith("dall-e")) {
            return { data: [{ b64_json: PNG_B64 }] };
          }
          return imageStream(IMAGE_USAGE);
        },
        edit: async (body: Record<string, unknown>) => {
          requested.push(body);
          return imageStream(IMAGE_USAGE);
        },
      },
    };
    setOpenAIClientForTests(fakeClient);
    runtimeTestOnly.setOpenAIClientForTests(fakeClient);
  });

  afterEach(() => {
    setOpenAIClientForTests(undefined);
    runtimeTestOnly.setOpenAIClientForTests(undefined);
  });

  it("carries the text/image split off a generation's terminal event", async () => {
    const events = await drive(
      findRunFn("image.generation"),
      { prompt: "a cat" },
      "gpt-image-2.5-sunburst"
    );
    expect(finishUsage(events)).toEqual({
      input: 60,
      output: 1056,
      cached: undefined,
      cacheWrite: undefined,
      imageInput: 1500,
      reasoning: undefined,
      total: 2616,
      extra: undefined,
    });
  });

  it("carries it off an edit's terminal event too", async () => {
    const events = await drive(
      findRunFn("image.editing"),
      { prompt: "make it blue", image: `data:image/png;base64,${PNG_B64}` },
      "gpt-image-2.5-flare"
    );
    expect(finishUsage(events)?.imageInput).toBe(1500);
    expect(finishUsage(events)?.input).toBe(60);
  });

  it("reports nothing for DALL-E, which states no usage at all", async () => {
    // Not zero: a model that says nothing about its tokens has not told us it
    // billed none, and DALL-E is per-image billed anyway.
    const events = await drive(findRunFn("image.generation"), { prompt: "a cat" }, "dall-e-3");
    expect(finishUsage(events)).toBeUndefined();
  });

  it("prices the whole prompt, image bucket included, with no partial marker", () => {
    // The point of the split: $5/1M on 60 text tokens, $8/1M on 1500 image
    // tokens, $30/1M on 1056 output tokens. Priced as one flat input bucket the
    // image half would come in at $5 and undercount the prompt by $0.0045.
    const usage: Usage = {
      input: 60,
      output: 1056,
      cached: undefined,
      cacheWrite: undefined,
      imageInput: 1500,
      reasoning: undefined,
      total: 2616,
      extra: undefined,
    };
    const pricing = getOpenAiModelPricing("gpt-image-2.5-sunburst");
    const estimate = estimateCost(usage, pricing as ModelPricing);
    expect(estimate?.unpriced).toEqual([]);
    expect(estimate?.amount).toBeCloseTo((60 * 5 + 1500 * 8 + 1056 * 30) / 1_000_000, 10);
    expect(formatCost(estimate).startsWith("~")).toBe(false);
  });
});
