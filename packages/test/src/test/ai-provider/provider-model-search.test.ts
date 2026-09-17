/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn } from "@workglow/ai";
import { collectStream, createEmitQueue, MODEL_EFFORTS, ModelSearchTask } from "@workglow/ai";
import { Anthropic_ModelSearch_Stream as Anthropic_ModelSearch } from "@workglow/anthropic/ai";
import { DeepSeek_ModelSearch_Stream as DeepSeek_ModelSearch } from "@workglow/deepseek/ai";
import { Gemini_ModelSearch_Stream as Gemini_ModelSearch } from "@workglow/google-gemini/ai";
import { HFI_ModelSearch } from "@workglow/huggingface-inference/ai";
import { OpenAI_ModelSearch_Stream as OpenAI_ModelSearch } from "@workglow/openai/ai";
import { mapOpenRouterModels, OPENROUTER_FALLBACK_MODELS } from "@workglow/openrouter/ai";
import {
  TENSORFLOW_MEDIAPIPE,
  _testOnly as tfmp,
  TFMP_ModelSearch,
} from "@workglow/tf-mediapipe/ai";
import { asText } from "@workglow/util";
import { Xai_ModelSearch_Stream as Xai_ModelSearch } from "@workglow/xai/ai";
import { afterEach, describe, expect, test } from "vitest";

const originalFetch = globalThis.fetch;

async function runFnToIterable(fn: AiProviderRunFn<any, any>, input: any) {
  const q = createEmitQueue<any>();
  fn(input, undefined as any, new AbortController().signal, (e) => q.push(e)).then(
    () => q.close(),
    (e) => q.fail(e)
  );
  return q.iterable;
}

interface ModelSearchResult {
  readonly id: string;
  readonly label?: string;
  readonly description?: string;
  readonly record?: unknown;
}

async function modelIdsForSearch(
  search: AiProviderRunFn<any, any>,
  query: string
): Promise<string[]> {
  const { results } = (await collectStream(await runFnToIterable(search, { query }))) as {
    results: ModelSearchResult[];
  };
  return results.map((model) => model.id);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("provider model search samples", () => {
  test("ModelSearchTask input schema marks credential_key as a credential", () => {
    const schema = ModelSearchTask.inputSchema();
    expect(schema).toMatchObject({
      properties: {
        credential_key: { type: "string", format: "credential" },
      },
    });
  });

  test("OpenAI fallback includes the latest flagship sample", async () => {
    await expect(modelIdsForSearch(OpenAI_ModelSearch, "gpt-6-astra")).resolves.toContain(
      "gpt-6-astra"
    );
    await expect(modelIdsForSearch(OpenAI_ModelSearch, "gpt-5.5")).resolves.toContain("gpt-5.5");
  });

  test("OpenAI fallback stamps effort_options by class", async () => {
    const { results } = (await collectStream(
      await runFnToIterable(OpenAI_ModelSearch, { query: "" })
    )) as { results: Array<{ id: string; record?: { effort_options?: string[] } }> };
    const sol = results.find((r) => r.id === "gpt-5.6-sol");
    const image = results.find((r) => r.id === "gpt-image-2");
    expect(sol?.record?.effort_options).toEqual([...MODEL_EFFORTS]);
    expect(image?.record?.effort_options).toEqual([]);
  });

  test("Anthropic fallback stamps effort_options for Claude", async () => {
    const { results } = (await collectStream(
      await runFnToIterable(Anthropic_ModelSearch, { query: "claude-sonnet-5" })
    )) as { results: Array<{ id: string; record?: { effort_options?: string[] } }> };
    const sonnet = results.find((r) => r.id === "claude-sonnet-5");
    expect(sonnet?.record?.effort_options).toEqual([...MODEL_EFFORTS]);
  });

  test("Gemini fallback stamps effort_options by class", async () => {
    const { results } = (await collectStream(
      await runFnToIterable(Gemini_ModelSearch, { query: "" })
    )) as { results: Array<{ id: string; record?: { effort_options?: string[] } }> };
    const flash = results.find((r) => r.id === "gemini-3.8-flash");
    const embedding = results.find((r) => r.id === "gemini-embedding-2");
    expect(flash?.record?.effort_options).toEqual([...MODEL_EFFORTS]);
    expect(embedding?.record?.effort_options).toEqual([]);
  });

  test("DeepSeek fallback stamps effort_options for v4", async () => {
    const { results } = (await collectStream(
      await runFnToIterable(DeepSeek_ModelSearch, { query: "deepseek-v4-flash" })
    )) as { results: Array<{ id: string; record?: { effort_options?: string[] } }> };
    const flash = results.find((r) => r.id === "deepseek-v4-flash");
    expect(flash?.record?.effort_options).toEqual([...MODEL_EFFORTS]);
  });

  test("OpenRouter mapper stamps all six effort_options", () => {
    const [first] = mapOpenRouterModels(OPENROUTER_FALLBACK_MODELS);
    expect(first?.record?.effort_options).toEqual([...MODEL_EFFORTS]);
  });

  test("xAI fallback stamps effort_options by class", async () => {
    const { results } = (await collectStream(
      await runFnToIterable(Xai_ModelSearch, { query: "" })
    )) as { results: Array<{ id: string; record?: { effort_options?: string[] } }> };
    expect(results.find((r) => r.id === "grok-4")?.record?.effort_options).toEqual([
      ...MODEL_EFFORTS,
    ]);
    expect(
      results.find((r) => r.id === "grok-4-fast-non-reasoning")?.record?.effort_options
    ).toEqual([]);
    expect(results.find((r) => r.id === "grok-2-image-1212")?.record?.effort_options).toEqual([]);
  });

  test("Anthropic fallback includes the latest Claude samples", async () => {
    await expect(modelIdsForSearch(Anthropic_ModelSearch, "claude-opus-4-7")).resolves.toContain(
      "claude-opus-4-7"
    );
    await expect(modelIdsForSearch(Anthropic_ModelSearch, "claude-sonnet-4-6")).resolves.toContain(
      "claude-sonnet-4-6"
    );
  });

  test("DeepSeek fallback includes V4.1 Flash", async () => {
    await expect(modelIdsForSearch(DeepSeek_ModelSearch, "deepseek-flash")).resolves.toContain(
      "deepseek-flash"
    );
  });

  test("DeepSeek fallback includes the V4 Pro 0813 GA snapshot", async () => {
    await expect(modelIdsForSearch(DeepSeek_ModelSearch, "0813")).resolves.toContain(
      "deepseek-v4-pro-0813"
    );
  });

  test("Gemini static list includes current text, image, and embedding samples", async () => {
    await expect(
      modelIdsForSearch(Gemini_ModelSearch, "gemini-3.1-pro-preview")
    ).resolves.toContain("gemini-3.1-pro-preview");
    await expect(
      modelIdsForSearch(Gemini_ModelSearch, "gemini-3.1-flash-image")
    ).resolves.toContain("gemini-3.1-flash-image");
    await expect(modelIdsForSearch(Gemini_ModelSearch, "gemini-embedding-2")).resolves.toContain(
      "gemini-embedding-2"
    );
  });

  test("Gemini live search uses the supplied credential", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl = asText(input);
      return Response.json({
        models: [
          {
            name: "models/gemini-live-test",
            displayName: "Gemini Live Test",
            description: "Live model",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      });
    }) as unknown as typeof fetch;

    const { results } = (await collectStream(
      await runFnToIterable(Gemini_ModelSearch, {
        query: "live",
        credential_key: "test-gemini-key",
      })
    )) as { results: ModelSearchResult[] };

    expect(requestedUrl).toContain("key=test-gemini-key");
    expect(results.map((model) => model.id)).toContain("gemini-live-test");
    expect(results[0]?.label).toBe("Gemini Live Test");
    expect(results[0]?.description).toBe("gemini-live-test");
  });

  test("Gemini live search rejects API failures when credentialed", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;

    await expect(
      runFnToIterable(Gemini_ModelSearch, { query: "live", credential_key: "bad-gemini-key" }).then(
        collectStream
      )
    ).rejects.toThrow("Gemini API returned 401");
  });

  test("Hugging Face Inference live search uses the supplied credential", async () => {
    let authorization = "";
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      const headers = new Headers(init?.headers);
      authorization = headers.get("authorization") ?? "";
      return Response.json([
        {
          id: "org/live-hfi-model",
          modelId: "org/live-hfi-model",
          pipeline_tag: "text-generation",
          likes: 10,
          downloads: 100,
        },
      ]);
    }) as unknown as typeof fetch;

    const { results } = (await collectStream(
      await runFnToIterable(HFI_ModelSearch, { query: "live", credential_key: "test-hf-key" })
    )) as { results: ModelSearchResult[] };

    expect(authorization).toBe("Bearer test-hf-key");
    expect(results.map((model) => model.id)).toContain("org/live-hfi-model");
  });

  test("Hugging Face Inference live search rejects API failures when credentialed", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;

    await expect(
      runFnToIterable(HFI_ModelSearch, { query: "live", credential_key: "bad-hf-key" }).then(
        collectStream
      )
    ).rejects.toThrow("HuggingFace API returned 401");
  });

  // Lifecycle/meta capabilities describe what the provider can do to a model,
  // not what a model is for, so no catalog entry needs to advertise them.
  const TFMP_LIFECYCLE_CAPABILITIES = new Set([
    "model.count-tokens",
    "model.download",
    "model.download-remove",
    "model.info",
    "model.search",
  ]);

  test("TensorFlow MediaPipe search offers a model for every inference capability it serves", async () => {
    const { results } = (await collectStream(
      await runFnToIterable(TFMP_ModelSearch, { provider: TENSORFLOW_MEDIAPIPE, query: "" })
    )) as { results: ModelSearchResult[] };

    const offered = new Set(
      results.flatMap(
        (r) => (r.record as { capabilities?: string[] } | undefined)?.capabilities ?? []
      )
    );
    const served = [...new Set(tfmp.TFMP_RUN_FN_SPECS.flatMap((spec) => spec.serves))].filter(
      (capability) => !TFMP_LIFECYCLE_CAPABILITIES.has(capability)
    );

    // A served capability with no searchable model leaves the task's model
    // picker empty even though the provider can run it.
    expect(served.filter((capability) => !offered.has(capability))).toEqual([]);
  });

  test("TensorFlow MediaPipe search includes known model records", async () => {
    const { results } = (await collectStream(
      await runFnToIterable(TFMP_ModelSearch, { provider: TENSORFLOW_MEDIAPIPE, query: "pose" })
    )) as { results: ModelSearchResult[] };

    expect(results).toContainEqual(
      expect.objectContaining({
        id: "pose-landmarker",
        label: "Pose Landmarker",
        record: expect.objectContaining({
          provider: TENSORFLOW_MEDIAPIPE,
          title: "Pose Landmarker",
          capabilities: ["vision.pose-landmarks"],
          provider_config: expect.objectContaining({
            task_engine: "vision",
            pipeline: "vision-pose-landmarker",
            model_path: expect.stringContaining("pose_landmarker_lite.task"),
          }),
        }),
      })
    );
  });
});
