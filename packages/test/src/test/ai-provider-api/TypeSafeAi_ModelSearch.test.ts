/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, ModelInfoTaskOutput, ModelSearchTaskOutput } from "@workglow/ai";
import { _testOnly, TYPESAFEAI } from "@workglow/typesafeai/ai";
import { _testOnly as runtimeTestOnly } from "@workglow/typesafeai/ai-runtime";
import { afterEach, describe, expect, it } from "vitest";

const { TYPESAFEAI_RUN_FNS, setTypeSafeAiClientForTests } = _testOnly;

function runFnFor(capability: string): AiProviderRunFn {
  const registration = TYPESAFEAI_RUN_FNS.find(({ serves }) =>
    (serves as readonly string[]).includes(capability)
  );
  expect(registration).toBeDefined();
  return registration!.runFn as AiProviderRunFn;
}

function installClient(cards: readonly { name: string; description?: string }[]): void {
  const client = {
    systemOne: async () => ({ model: "jev", answers: {}, usage: {} }),
    models: { list: async () => cards },
  };
  setTypeSafeAiClientForTests(client as never);
  runtimeTestOnly.setTypeSafeAiClientForTests?.(client as never);
}

async function search(input: Record<string, unknown>): Promise<ModelSearchTaskOutput> {
  let data: ModelSearchTaskOutput | undefined;
  await runFnFor("model.search")(
    { provider: TYPESAFEAI, ...input },
    undefined as never,
    new AbortController().signal,
    (ev) => {
      if (ev.type === "finish") data = ev.data as ModelSearchTaskOutput;
    }
  );
  return data!;
}

describe("TypeSafeAi_ModelSearch", () => {
  afterEach(() => {
    setTypeSafeAiClientForTests(undefined);
    runtimeTestOnly.setTypeSafeAiClientForTests?.(undefined);
  });

  // A catalog browser should still be able to offer a model to add before a key
  // has been named for the provider.
  it("falls back to the documented aliases with no credential key", async () => {
    installClient([{ name: "should-not-be-read" }]);

    const out = await search({});

    expect(out.results.map((r) => r.id)).toEqual(["jev-latest", "jev-preview"]);
  });

  it("lists the account's models when a credential key is given", async () => {
    installClient([
      { name: "jev-preview", description: "A preview version" },
      { name: "jev-latest", description: "The latest iteration" },
    ]);

    const out = await search({ credential_key: "typesafe-api-key" });

    // Sorted by id so the catalog order does not depend on what the API sent.
    expect(out.results.map((r) => r.id)).toEqual(["jev-latest", "jev-preview"]);
    expect(out.results[0]!.description).toBe("The latest iteration");
  });

  it("filters the list by query", async () => {
    installClient([{ name: "jev-latest" }, { name: "jev-preview" }]);

    const out = await search({ credential_key: "k", query: "preview" });

    expect(out.results.map((r) => r.id)).toEqual(["jev-preview"]);
  });

  // Stamping a capability list here would make a searched record and a
  // hand-typed one disagree about the same model; inferCapabilities owns it.
  it("seeds a record with no capabilities, leaving inference to fill them", async () => {
    installClient([{ name: "jev-latest" }]);

    const out = await search({ credential_key: "k" });

    expect(out.results[0]!.record.provider).toBe(TYPESAFEAI);
    expect(out.results[0]!.record.capabilities).toEqual([]);
    expect(out.results[0]!.record.provider_config).toEqual({ model_name: "jev-latest" });
  });
});

describe("TypeSafeAi_ModelInfo", () => {
  afterEach(() => {
    setTypeSafeAiClientForTests(undefined);
    runtimeTestOnly.setTypeSafeAiClientForTests?.(undefined);
  });

  const modelConfig = (modelName: string | undefined) =>
    ({
      model_id: modelName ?? "",
      title: "jev",
      description: "",
      provider: TYPESAFEAI,
      provider_config: { model_name: modelName, api_key: "test-key" },
      capabilities: ["model.info"],
      metadata: {},
    }) as never;

  // `GET /v1/models` lists only the aliases, and the vendor states a versioned
  // id is accepted whether or not it appears there — so checking membership
  // would reject the exact ids callers are told to pin.
  it("reports a pinned version without checking it against the alias list", async () => {
    let listed = 0;
    const client = {
      systemOne: async () => ({ model: "jev", answers: {}, usage: {} }),
      models: {
        list: async () => {
          listed += 1;
          return [{ name: "jev-latest" }, { name: "jev-preview" }];
        },
      },
    };
    setTypeSafeAiClientForTests(client as never);
    runtimeTestOnly.setTypeSafeAiClientForTests?.(client as never);

    const model = modelConfig("jev-1.13.0");
    let data: ModelInfoTaskOutput | undefined;
    await runFnFor("model.info")(
      { model: "jev-1.13.0" },
      model,
      new AbortController().signal,
      (ev) => {
        if (ev.type === "finish") data = ev.data as ModelInfoTaskOutput;
      }
    );

    expect(listed).toBe(0);
    expect(data?.is_remote).toBe(true);
    expect(data?.is_local).toBe(false);
  });

  it("fails on a record carrying no model name rather than at the next request", async () => {
    const model = modelConfig(undefined);
    await expect(
      runFnFor("model.info")({ model: "" }, model, new AbortController().signal, () => {})
    ).rejects.toThrow(/model_name/);
  });
});
