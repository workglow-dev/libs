/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  AiSessionContext,
  CacheCheckpointTaskInput,
  TextGenerationTaskInput,
  ToolCallingTaskInput,
  ToolDefinition,
} from "@workglow/ai";
import { GOOGLE_GEMINI, _testOnly } from "@workglow/google-gemini/ai";
import * as GeminiRuntime from "@workglow/google-gemini/ai-runtime";
import {
  buildGeminiPrefixedContents,
  deleteGeminiCachedContent,
  geminiCachedToolsMatch,
  _testOnly as runtimeTestOnly,
} from "@workglow/google-gemini/ai-runtime";
import { _testOnly as openAiTestOnly } from "@workglow/openai/ai";
import {
  mergeOpenAICheckpointPrefix,
  _testOnly as openAiRuntimeTestOnly,
} from "@workglow/openai/ai-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The ai-runtime bundle carries its own copy of the cache-store map,
 * independent of the ai bundle's. The pre-existing store-lifecycle test uses
 * the ai-runtime copy because `deleteGeminiCachedContent` is imported off
 * ai-runtime and clears its own map.
 */
const runtimeTestOnlyStore = {
  setGeminiCachedContent: GeminiRuntime.setGeminiCachedContent,
  getGeminiCachedContent: GeminiRuntime.getGeminiCachedContent,
};

// The ai bundle carries its own copy of the cache-store map (independent of
// ai-runtime's). Route reads and writes through the ai bundle's `_testOnly`
// helpers so the state the run-fns (also imported off the ai bundle) look at
// is exactly what the test seeds and inspects.
const setGeminiCachedContent = _testOnly.setGeminiCachedContent;
const getGeminiCachedContent = _testOnly.getGeminiCachedContent;
const _cacheStoreTestOnly = _testOnly.cacheStoreTestOnly;

const geminiRequests: Array<Record<string, unknown>> = [];

// Inject a fake Gemini client through the runtime's own test seam rather than
// `vi.mock("@google/genai")`. Module-level SDK mocks are unreliable here: the
// workspace ships several `@google/genai` copies and the provider resolves it
// to a bundled `dist` file the test's mock never intercepts. The seam records
// every request the run-fns build so we can assert on it without a live call.
// The `dist` build splits `ai.js` and `ai-runtime.js` into separate bundles
// with independent module state, so inject into both entrypoints.
const fakeGeminiClient = {
  models: {
    generateContentStream: async (request: Record<string, unknown>) => {
      geminiRequests.push(request);
      return {
        async *[Symbol.asyncIterator]() {},
      };
    },
  },
  caches: {
    create: async () => ({}),
    delete: async () => {},
  },
} as never;

beforeEach(() => {
  geminiRequests.length = 0;
  _testOnly.setGeminiClientForTests(fakeGeminiClient);
  runtimeTestOnly.setGeminiClientForTests(fakeGeminiClient);
  _cacheStoreTestOnly.clearForTests();
});

afterEach(() => {
  _testOnly.setGeminiClientForTests(undefined);
  runtimeTestOnly.setGeminiClientForTests(undefined);
  _cacheStoreTestOnly.clearForTests();
});

function getGeminiRequests(): Array<Record<string, unknown>> {
  return geminiRequests;
}

const prefix = {
  systemPrompt: "sys",
  tools: [{ name: "a", description: "A", inputSchema: { type: "object" as const } }],
  messages: [
    { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "hi" }] },
  ],
};

describe("mergeOpenAICheckpointPrefix", () => {
  it("returns undefined without a prefix so plain calls take the unmodified path", () => {
    expect(mergeOpenAICheckpointPrefix(undefined, { prompt: "p" })).toBeUndefined();
    expect(
      mergeOpenAICheckpointPrefix({ sessionId: "s" } as AiSessionContext, { prompt: "p" })
    ).toBeUndefined();
  });

  it("prepends prefix messages ahead of a prompt-only tail", () => {
    const session: AiSessionContext = { sessionId: "ckpt", prefix };
    const merged = mergeOpenAICheckpointPrefix(session, { prompt: "tail" });
    expect(merged).toBeDefined();
    expect(merged!.messages).toHaveLength(3);
    expect(merged!.messages[0]).toEqual(prefix.messages[0]);
    expect(merged!.messages[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "tail" }],
    });
    expect(merged!.systemPrompt).toBe("sys");
  });

  it("prefers the caller's messages tail and system prompt when present", () => {
    const session: AiSessionContext = { sessionId: "ckpt", prefix };
    const tail = [{ role: "user" as const, content: [{ type: "text" as const, text: "m" }] }];
    const merged = mergeOpenAICheckpointPrefix(session, {
      messages: tail,
      systemPrompt: "own",
      prompt: "ignored",
    });
    expect(merged!.messages).toHaveLength(3);
    expect(merged!.messages[2]).toEqual(tail[0]);
    expect(merged!.systemPrompt).toBe("own");
  });

  it("keeps the prefix system prompt when the caller passes an empty string", () => {
    const session: AiSessionContext = { sessionId: "ckpt", prefix };
    const merged = mergeOpenAICheckpointPrefix(session, { prompt: "tail", systemPrompt: "" });
    expect(merged!.systemPrompt).toBe("sys");
  });

  it("returns the prefix tools when the caller declares none", () => {
    const session: AiSessionContext = { sessionId: "ckpt", prefix };
    expect(mergeOpenAICheckpointPrefix(session, { prompt: "tail" })!.tools).toEqual(prefix.tools);
    expect(mergeOpenAICheckpointPrefix(session, { prompt: "tail", tools: [] })!.tools).toEqual(
      prefix.tools
    );
  });

  it("prefers the caller's tools when it declares any", () => {
    const session: AiSessionContext = { sessionId: "ckpt", prefix };
    const own: ToolDefinition[] = [
      { name: "mine", description: "Mine", inputSchema: { type: "object" } },
    ];
    expect(mergeOpenAICheckpointPrefix(session, { prompt: "tail", tools: own })!.tools).toEqual(
      own
    );
  });
});

/**
 * Request-level parity: drive the real OpenAI warm-up and consumer run-fns
 * through the client test seam and compare the captured Responses requests.
 * The seam is set on both the `ai` and `ai-runtime` entrypoints because the
 * dist build splits them into bundles with independent module state.
 */
describe("OpenAI checkpoint prompt_cache_key parity", () => {
  const openAiRequests: Array<Record<string, unknown>> = [];
  const fakeOpenAiClient = {
    responses: {
      create: async (request: Record<string, unknown>) => {
        openAiRequests.push(request);
        return { async *[Symbol.asyncIterator]() {} };
      },
    },
  } as never;
  const openAiModel = { provider_config: { model_name: "gpt-test" } } as never;

  beforeEach(() => {
    openAiRequests.length = 0;
    openAiTestOnly.setOpenAIClientForTests(fakeOpenAiClient);
    openAiRuntimeTestOnly.setOpenAIClientForTests(fakeOpenAiClient);
  });

  afterEach(() => {
    openAiTestOnly.setOpenAIClientForTests(undefined);
    openAiRuntimeTestOnly.setOpenAIClientForTests(undefined);
  });

  /** Registration lookup — first entry whose `serves` includes the capability. */
  function findOpenAiRunFn(capability: string): AiProviderRunFn {
    const registration = openAiTestOnly.OPENAI_RUN_FNS.find(({ serves }) =>
      (serves as readonly string[]).includes(capability)
    );
    expect(registration).toBeDefined();
    return registration!.runFn as AiProviderRunFn;
  }

  async function runWarmUp(session: AiSessionContext): Promise<void> {
    const warmUp = findOpenAiRunFn("cache.checkpoint");
    const input: CacheCheckpointTaskInput = { model: "gpt-test" };
    await warmUp(input, openAiModel, new AbortController().signal, () => {}, undefined, session);
  }

  it("a text consumer of a tools-warmed prefix matches the warm-up key and tools", async () => {
    const session: AiSessionContext = { sessionId: "ckpt-oai", prefix };
    await runWarmUp(session);

    const consume = findOpenAiRunFn("text.generation");
    const input: TextGenerationTaskInput = { model: "gpt-test", prompt: "tail" };
    await consume(input, openAiModel, new AbortController().signal, () => {}, undefined, session);

    expect(openAiRequests).toHaveLength(2);
    const [warmUpRequest, consumerRequest] = openAiRequests;
    expect(warmUpRequest.prompt_cache_key).toBeDefined();
    expect(consumerRequest.prompt_cache_key).toBe(warmUpRequest.prompt_cache_key);
    expect(consumerRequest.tools).toEqual(warmUpRequest.tools);
    expect(consumerRequest.instructions).toBe(warmUpRequest.instructions);
    // tool_choice stays unset, matching the warm-up request
    expect(consumerRequest.tool_choice).toBeUndefined();
  });

  it.each([
    ["a reasoning model replays", "gpt-5", true],
    ["a model without reasoning rebuilds", "gpt-4.1", false],
  ])(
    "writes a native turn and a tool image the same way in warm-up and tool calling: %s it",
    async (_label, modelName, replays) => {
      const model = { provider_config: { model_name: modelName } } as never;
      const nativeItems = [
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC" },
        { type: "function_call", call_id: "c1", name: "a", arguments: "{}" },
      ];
      const replayPrefix = {
        systemPrompt: "sys",
        tools: prefix.tools,
        messages: [
          { role: "user" as const, content: [{ type: "text" as const, text: "look" }] },
          {
            role: "assistant" as const,
            content: [
              {
                type: "reasoning" as const,
                text: "",
                provider: `openai:${modelName}`,
                payload: JSON.stringify(nativeItems),
              },
              { type: "tool_use" as const, id: "c1", name: "a", input: {} },
            ],
          },
          {
            role: "tool" as const,
            content: [
              {
                type: "tool_result" as const,
                tool_use_id: "c1",
                content: [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }],
              },
            ],
          },
        ],
      };
      const session = { sessionId: `ckpt-${modelName}`, prefix: replayPrefix } as AiSessionContext;
      await findOpenAiRunFn("cache.checkpoint")(
        { model: modelName } as CacheCheckpointTaskInput,
        model,
        new AbortController().signal,
        () => {},
        undefined,
        session
      );
      await findOpenAiRunFn("tool-use")(
        { model: modelName, prompt: "tail", tools: [] } as never,
        model,
        new AbortController().signal,
        () => {},
        undefined,
        session
      );

      expect(openAiRequests).toHaveLength(2);
      const [warmUpRequest, consumerRequest] = openAiRequests;
      const warmed = warmUpRequest.input as unknown[];
      const sent = consumerRequest.input as unknown[];
      expect(sent.slice(0, warmed.length)).toEqual(warmed);
      expect(sent.length).toBeGreaterThan(warmed.length);
      if (replays) expect(warmed).toContainEqual(nativeItems[0]);
      else expect(warmed).not.toContainEqual(nativeItems[0]);
    }
  );

  it("writes a tool image the same way in warm-up and text generation", async () => {
    const model = { provider_config: { model_name: "gpt-4.1" } } as never;
    const imagePrefix = {
      systemPrompt: "sys",
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: "look" }] },
        {
          role: "assistant" as const,
          content: [{ type: "tool_use" as const, id: "c1", name: "a", input: {} }],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: "c1",
              content: [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }],
            },
          ],
        },
      ],
    };
    const session = { sessionId: "ckpt-text-image", prefix: imagePrefix } as AiSessionContext;
    await findOpenAiRunFn("cache.checkpoint")(
      { model: "gpt-4.1" } as CacheCheckpointTaskInput,
      model,
      new AbortController().signal,
      () => {},
      undefined,
      session
    );
    await findOpenAiRunFn("text.generation")(
      { model: "gpt-4.1", prompt: "tail" } as TextGenerationTaskInput,
      model,
      new AbortController().signal,
      () => {},
      undefined,
      session
    );
    const [warmUpRequest, consumerRequest] = openAiRequests;
    const warmed = warmUpRequest!.input as unknown[];
    const sent = consumerRequest!.input as unknown[];
    expect(sent.slice(0, warmed.length)).toEqual(warmed);
    expect(JSON.stringify(warmed)).toContain("data:image/png;base64,AAAA");
  });

  it("an empty-string system prompt keeps the warmed instructions and cache key", async () => {
    const session: AiSessionContext = { sessionId: "ckpt-oai-2", prefix };
    await runWarmUp(session);

    const consume = findOpenAiRunFn("text.generation");
    const input = {
      model: "gpt-test",
      prompt: "tail",
      systemPrompt: "",
    } as unknown as TextGenerationTaskInput;
    await consume(input, openAiModel, new AbortController().signal, () => {}, undefined, session);

    expect(openAiRequests).toHaveLength(2);
    const [warmUpRequest, consumerRequest] = openAiRequests;
    expect(consumerRequest.instructions).toBe(warmUpRequest.instructions);
    expect(consumerRequest.prompt_cache_key).toBe(warmUpRequest.prompt_cache_key);
  });
});

describe("buildGeminiPrefixedContents", () => {
  it("renders prefix messages followed by the prompt tail", () => {
    const contents = buildGeminiPrefixedContents(prefix, undefined, "tail");
    expect(contents).toHaveLength(3);
    expect(contents[0].role).toBe("user");
    expect(contents[0].parts[0].text).toBe("hello");
    expect(contents[1].role).toBe("model");
    expect(contents[2].parts[0].text).toBe("tail");
  });

  it("prefers a messages tail over the prompt", () => {
    const tail = [{ role: "user" as const, content: [{ type: "text" as const, text: "m" }] }];
    const contents = buildGeminiPrefixedContents(prefix, tail, "ignored");
    expect(contents).toHaveLength(3);
    expect(contents[2].parts[0].text).toBe("m");
  });
});

const cachedTools: ToolDefinition[] = [
  {
    name: "weather",
    description: "Get weather",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string", description: "City" },
        units: { type: "string", enum: ["c", "f"] },
      },
      required: ["location"],
      additionalProperties: false,
    },
  },
  {
    name: "time",
    description: "Get time",
    inputSchema: {
      type: "object",
      properties: { timezone: { type: "string" } },
    },
  },
];

describe("geminiCachedToolsMatch", () => {
  it("matches reordered tools and nested schema keys", () => {
    const reordered: ToolDefinition[] = [
      {
        ...cachedTools[1],
        inputSchema: {
          properties: { timezone: { type: "string" } },
          type: "object",
        },
      },
      {
        ...cachedTools[0],
        inputSchema: {
          additionalProperties: true,
          required: ["location"],
          properties: {
            units: { enum: ["c", "f"], type: "string" },
            location: { description: "City", type: "string" },
          },
          type: "object",
        },
      },
    ];

    expect(geminiCachedToolsMatch(cachedTools, reordered)).toBe(true);
  });

  it("matches equivalent required-property order permutations", () => {
    const reorderedRequired: ToolDefinition[] = [
      {
        name: "coordinates",
        description: "Resolve coordinates",
        inputSchema: {
          type: "object",
          properties: {
            latitude: { type: "number" },
            longitude: { type: "number" },
          },
          required: ["longitude", "latitude"],
        },
      },
    ];
    const original: ToolDefinition[] = [
      {
        name: "coordinates",
        description: "Resolve coordinates",
        inputSchema: {
          type: "object",
          properties: {
            latitude: { type: "number" },
            longitude: { type: "number" },
          },
          required: ["latitude", "longitude"],
        },
      },
    ];

    expect(geminiCachedToolsMatch(original, reorderedRequired)).toBe(true);
  });

  it("matches reordered Unicode enum values with locale-equivalent spellings", () => {
    const composed = "é";
    const decomposed = "e\u0301";
    const original: ToolDefinition[] = [
      {
        name: "unicode",
        description: "Accept Unicode",
        inputSchema: { enum: [composed, decomposed] },
      },
    ];
    const reordered: ToolDefinition[] = [
      {
        ...original[0],
        inputSchema: { enum: [decomposed, composed] },
      },
    ];

    expect(geminiCachedToolsMatch(original, reordered)).toBe(true);
  });

  it("normalizes schemas under legacy additionalItems", () => {
    const first: ToolDefinition[] = [
      {
        name: "legacyTuple",
        description: "Accept a legacy tuple",
        inputSchema: {
          type: "array",
          items: [{ type: "string" }],
          additionalItems: {
            type: "object",
            properties: {
              left: { type: "string" },
              right: { type: "string" },
            },
            required: ["left", "right"],
          },
        } as unknown as ToolDefinition["inputSchema"],
      },
    ];
    const reordered: ToolDefinition[] = [
      {
        ...first[0],
        inputSchema: {
          type: "array",
          items: [{ type: "string" }],
          additionalItems: {
            required: ["right", "left"],
            properties: {
              right: { type: "string" },
              left: { type: "string" },
            },
            type: "object",
          },
        } as unknown as ToolDefinition["inputSchema"],
      },
    ];

    expect(geminiCachedToolsMatch(first, reordered)).toBe(true);
  });

  it("preserves semantically ordered prefix-item arrays", () => {
    const stringThenNumber: ToolDefinition[] = [
      {
        name: "orderedTuple",
        description: "Accept an ordered tuple",
        inputSchema: {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "number" }],
        } as unknown as ToolDefinition["inputSchema"],
      },
    ];
    const numberThenString: ToolDefinition[] = [
      {
        ...stringThenNumber[0],
        inputSchema: {
          type: "array",
          prefixItems: [{ type: "number" }, { type: "string" }],
        } as unknown as ToolDefinition["inputSchema"],
      },
    ];

    expect(geminiCachedToolsMatch(stringThenNumber, numberThenString)).toBe(false);
  });

  it("preserves arrays nested in const instance values", () => {
    const original: ToolDefinition[] = [
      {
        name: "literal",
        description: "Accept a literal",
        inputSchema: { const: { enum: ["a", "b"] } },
      },
    ];
    const reversed: ToolDefinition[] = [
      {
        ...original[0],
        inputSchema: { const: { enum: ["b", "a"] } },
      },
    ];

    expect(geminiCachedToolsMatch(original, reversed)).toBe(false);
  });

  it("preserves arrays inside unordered enum instance entries", () => {
    const original: ToolDefinition[] = [
      {
        name: "enumLiteral",
        description: "Accept an enum literal",
        inputSchema: { enum: [{ required: ["a", "b"] }] },
      },
    ];
    const reversed: ToolDefinition[] = [
      {
        ...original[0],
        inputSchema: { enum: [{ required: ["b", "a"] }] },
      },
    ];

    expect(geminiCachedToolsMatch(original, reversed)).toBe(false);
  });

  it("rejects added and removed declarations", () => {
    expect(geminiCachedToolsMatch(cachedTools, cachedTools.slice(0, 1))).toBe(false);
    expect(
      geminiCachedToolsMatch(cachedTools.slice(0, 1), [...cachedTools.slice(0, 1), cachedTools[1]])
    ).toBe(false);
  });

  it("rejects a changed input schema", () => {
    const changed: ToolDefinition[] = [
      {
        ...cachedTools[0],
        inputSchema: {
          type: "object",
          required: ["location"],
          properties: {
            location: { type: "number" },
            units: { type: "string", enum: ["c", "f"] },
          },
        },
      },
      cachedTools[1],
    ];

    expect(geminiCachedToolsMatch(cachedTools, changed)).toBe(false);
  });

  it("compares wire descriptions while ignoring non-wire tool fields", () => {
    const nonWireChanged: ToolDefinition[] = cachedTools.map((tool) => ({
      ...tool,
      type: "function",
      config: { localOnly: true },
      configSchema: { type: "object", properties: { localOnly: { type: "boolean" } } },
      execute: async () => ({ localOnly: true }),
    }));
    const descriptionChanged: ToolDefinition[] = [
      { ...cachedTools[0], description: "Get forecast" },
      cachedTools[1],
    ];
    const nameChanged: ToolDefinition[] = [{ ...cachedTools[0], name: "forecast" }, cachedTools[1]];
    const outputSchemaChanged: ToolDefinition[] = [
      { ...cachedTools[0], outputSchema: { type: "object" } },
      cachedTools[1],
    ];

    expect(geminiCachedToolsMatch(cachedTools, nonWireChanged)).toBe(true);
    expect(geminiCachedToolsMatch(cachedTools, descriptionChanged)).toBe(false);
    expect(geminiCachedToolsMatch(cachedTools, nameChanged)).toBe(false);
    expect(geminiCachedToolsMatch(cachedTools, outputSchemaChanged)).toBe(false);
  });
});

describe("Gemini tool-calling cached-content parity", () => {
  it("inline-replays the prefix and sends current declarations when cached tools differ", async () => {
    const checkpointId = "test-ckpt-tool-mismatch";
    const currentTools: ToolDefinition[] = [
      {
        name: "forecast",
        description: "Get the forecast",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];
    const session: AiSessionContext = {
      sessionId: checkpointId,
      prefix: {
        systemPrompt: "Use tools.",
        tools: cachedTools.slice(0, 1),
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Cached prefix message" }],
          },
        ],
      },
    };
    setGeminiCachedContent(checkpointId, {
      name: "cachedContents/stale-tools",
      model: {
        provider_config: { api_key: "test-tool-mismatch", model_name: "gemini-test" },
      } as never,
      systemPrompt: "Use tools.",
    });
    const geminiRequests = getGeminiRequests();
    geminiRequests.length = 0;

    const registration = _testOnly.GEMINI_RUN_FNS.find(({ serves }) => serves.includes("tool-use"));
    expect(registration).toBeDefined();
    const input: ToolCallingTaskInput = {
      model: "gemini-test",
      prompt: "Current tail message",
      tools: currentTools,
      toolChoice: "auto",
    };
    await (registration!.runFn as AiProviderRunFn)(
      input,
      {
        provider: GOOGLE_GEMINI,
        provider_config: { api_key: "test-tool-mismatch", model_name: "gemini-test" },
      } as never,
      new AbortController().signal,
      () => {},
      undefined,
      session
    );

    expect(geminiRequests).toHaveLength(1);
    const request = geminiRequests[0] as {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      config: {
        cachedContent?: string;
        tools?: Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
        toolConfig?: Record<string, unknown>;
      };
    };
    expect(request.config.cachedContent).toBeUndefined();
    expect(request.config.tools?.[0].functionDeclarations).toEqual([
      {
        name: "forecast",
        description: "Get the forecast",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ]);
    expect(request.config.toolConfig).toEqual({
      functionCallingConfig: { mode: "AUTO" },
    });
    expect(request.contents.map(({ parts }) => parts[0].text)).toEqual([
      "Cached prefix message",
      "Current tail message",
    ]);

    await deleteGeminiCachedContent(checkpointId);
  });
});

describe("Gemini cached-content store", () => {
  it("stores, retrieves, and idempotently deletes entries", async () => {
    const id = "test-ckpt-store";
    // Use the ai-runtime bundle's own set/get here — the ai-runtime delete path
    // clears the ai-runtime map, so seeding via the same bundle keeps this
    // test focused on store lifecycle without cross-bundle plumbing.
    const set = runtimeTestOnlyStore.setGeminiCachedContent;
    const get = runtimeTestOnlyStore.getGeminiCachedContent;
    expect(get(id)).toBeUndefined();
    set(id, {
      name: "cachedContents/abc",
      // Deletion lazily builds a client from this config; the entry is removed
      // from the map before the API call, and API failures are swallowed, so a
      // dummy key is fine here.
      model: { provider_config: { api_key: "test", model_name: "gemini-x" } } as never,
      systemPrompt: "sys",
    });
    expect(get(id)?.name).toBe("cachedContents/abc");
    await deleteGeminiCachedContent(id);
    expect(get(id)).toBeUndefined();
    // second delete is a no-op
    await deleteGeminiCachedContent(id);
  });
});

/**
 * Overrides only the client methods the test cares about, keeping the shared
 * `fakeGeminiClient` shape and the request-log seam intact so every override
 * still exercises the same run-fn wiring.
 */
function installGeminiClient(overrides: {
  cachesCreate?: (...args: unknown[]) => Promise<Record<string, unknown>>;
  cachesDelete?: (arg: { name: string }) => Promise<void>;
  generateContentStream?: (
    request: Record<string, unknown>
  ) => Promise<AsyncIterable<Record<string, unknown>>>;
}): { deletedNames: string[]; createCalls: number } {
  const deletedNames: string[] = [];
  let createCalls = 0;
  const client = {
    models: {
      generateContentStream:
        overrides.generateContentStream ??
        (async (request: Record<string, unknown>) => {
          geminiRequests.push(request);
          return { async *[Symbol.asyncIterator]() {} };
        }),
    },
    caches: {
      create: async (...args: unknown[]) => {
        createCalls += 1;
        if (overrides.cachesCreate) {
          return await overrides.cachesCreate(...args);
        }
        return {};
      },
      delete: async (arg: { name: string }) => {
        deletedNames.push(arg.name);
        if (overrides.cachesDelete) await overrides.cachesDelete(arg);
      },
    },
  } as never;
  _testOnly.setGeminiClientForTests(client);
  runtimeTestOnly.setGeminiClientForTests(client);
  return {
    deletedNames,
    get createCalls() {
      return createCalls;
    },
  } as { deletedNames: string[]; createCalls: number };
}

/** Registration lookup — the `serves` list of the run-fn we want to drive. */
function findGeminiRunFn(capability: string): AiProviderRunFn {
  const registration = _testOnly.GEMINI_RUN_FNS.find(({ serves }) =>
    (serves as readonly string[]).includes(capability)
  );
  expect(registration).toBeDefined();
  return registration!.runFn as AiProviderRunFn;
}

const testModel = {
  provider: GOOGLE_GEMINI,
  provider_config: { api_key: "test-key", model_name: "gemini-test" },
} as never;

describe("Gemini cache checkpoint warm-up error classification", () => {
  const cacheCheckpointPrefix = {
    systemPrompt: "sys",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  };
  const cacheCheckpointInput: CacheCheckpointTaskInput = {
    model: "gemini-test",
  };

  it("rethrows an abort and best-effort deletes any resource created before the abort", async () => {
    const checkpointId = "abort-before-create";
    const controller = new AbortController();
    const helper = installGeminiClient({
      cachesCreate: async () => {
        controller.abort();
        const err = new Error("The user aborted the request.");
        err.name = "AbortError";
        throw err;
      },
    });
    const runFn = findGeminiRunFn("cache.checkpoint");
    const events: unknown[] = [];
    await expect(
      runFn(
        cacheCheckpointInput,
        testModel,
        controller.signal,
        (event) => events.push(event),
        undefined,
        { sessionId: checkpointId, prefix: cacheCheckpointPrefix }
      )
    ).rejects.toThrow(/abort/i);
    expect(events).toEqual([]);
    expect(getGeminiCachedContent(checkpointId)).toBeUndefined();
    // No resource name was ever returned, so nothing to server-delete.
    expect(helper.deletedNames).toEqual([]);
  });

  it("preserves the degrade-to-inline path on a prefix-too-small 400", async () => {
    const checkpointId = "degrade-preserved";
    installGeminiClient({
      cachesCreate: async () => {
        throw Object.assign(new Error("cached content prefix too small"), { status: 400 });
      },
    });
    const runFn = findGeminiRunFn("cache.checkpoint");
    const events: Array<Record<string, unknown>> = [];
    await runFn(
      cacheCheckpointInput,
      testModel,
      new AbortController().signal,
      (event) => events.push(event as Record<string, unknown>),
      undefined,
      { sessionId: checkpointId, prefix: cacheCheckpointPrefix }
    );
    // finish emitted, store empty, no rethrow
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("finish");
    expect(getGeminiCachedContent(checkpointId)).toBeUndefined();
  });

  it("rethrows a quota 429 without attempting to delete (no resource name)", async () => {
    const checkpointId = "throws-429";
    const helper = installGeminiClient({
      cachesCreate: async () => {
        throw Object.assign(new Error("quota"), { status: 429 });
      },
    });
    const runFn = findGeminiRunFn("cache.checkpoint");
    await expect(
      runFn(cacheCheckpointInput, testModel, new AbortController().signal, () => {}, undefined, {
        sessionId: checkpointId,
        prefix: cacheCheckpointPrefix,
      })
    ).rejects.toMatchObject({ status: 429 });
    expect(helper.deletedNames).toEqual([]);
    expect(getGeminiCachedContent(checkpointId)).toBeUndefined();
  });

  it("cleans up the created resource when a post-create step throws", async () => {
    const checkpointId = "partial-delete";
    const helper = installGeminiClient({
      cachesCreate: async () => ({ name: "cachedContents/abc" }),
    });
    // Inject a bookkeeping failure at the store-insert step so the classifier
    // sees a non-abort, non-degrade throw *after* a resource has been minted.
    _cacheStoreTestOnly.setPreSetHook(() => {
      throw new Error("bookkeeping failed");
    });
    try {
      const runFn = findGeminiRunFn("cache.checkpoint");
      await expect(
        runFn(cacheCheckpointInput, testModel, new AbortController().signal, () => {}, undefined, {
          sessionId: checkpointId,
          prefix: cacheCheckpointPrefix,
        })
      ).rejects.toThrow(/bookkeeping failed/);
      expect(helper.deletedNames).toEqual(["cachedContents/abc"]);
    } finally {
      _cacheStoreTestOnly.setPreSetHook(undefined);
    }
  });
});
describe("Gemini cachedContent NOT_FOUND fallback (text.generation)", () => {
  it("retries inline once on a cache-scoped 404 and evicts after the retry succeeds", async () => {
    const checkpointId = "not-found-text";
    setGeminiCachedContent(checkpointId, {
      name: "cachedContents/text",
      model: testModel,
      systemPrompt: "sys",
    });
    const requests: Record<string, unknown>[] = [];
    let call = 0;
    installGeminiClient({
      generateContentStream: async (request) => {
        requests.push(request);
        call += 1;
        if (call === 1) {
          throw Object.assign(new Error("cachedContents/text NOT_FOUND"), {
            status: 404,
            code: "NOT_FOUND",
          });
        }
        return { async *[Symbol.asyncIterator]() {} };
      },
    });
    const runFn = findGeminiRunFn("text.generation");
    const input: TextGenerationTaskInput = { model: "gemini-test", prompt: "tail" };
    const session: AiSessionContext = {
      sessionId: checkpointId,
      prefix: {
        systemPrompt: "sys",
        messages: [{ role: "user", content: [{ type: "text", text: "prefix" }] }],
      },
    };
    const events: Array<Record<string, unknown>> = [];
    await runFn(
      input,
      testModel,
      new AbortController().signal,
      (event) => events.push(event as Record<string, unknown>),
      undefined,
      session
    );
    expect(requests).toHaveLength(2);
    expect((requests[0].config as Record<string, unknown>).cachedContent).toBe(
      "cachedContents/text"
    );
    expect((requests[1].config as Record<string, unknown>).cachedContent).toBeUndefined();
    // Retry replays the prefix inline (prefix + tail messages).
    const retryContents = requests[1].contents as Array<{ parts: Array<{ text?: string }> }>;
    const retryTexts = retryContents.map((c) => c.parts[0]?.text);
    expect(retryTexts).toContain("prefix");
    expect(retryTexts).toContain("tail");
    expect(getGeminiCachedContent(checkpointId)).toBeUndefined();
    expect(events.some((e) => e.type === "finish")).toBe(true);
  });
});

describe("Gemini cachedContent NOT_FOUND fallback (tool-use)", () => {
  /**
   * The thrown error must be scoped to the cache (a `cachedContents/<id>`
   * mention) for the matcher to recognize it. A bare `{status: 404, code:
   * "NOT_FOUND", message: "cache not found"}` is deliberately NOT a hit — that
   * is a common non-cache failure shape, and treating it as one would buy a
   * second doomed call on every unrelated 404.
   */
  const cacheNotFoundError = (): Error =>
    Object.assign(new Error("cachedContents/tool NOT_FOUND"), {
      status: 404,
      code: "NOT_FOUND",
    });

  const toolSession = (checkpointId: string): AiSessionContext => ({
    sessionId: checkpointId,
    prefix: {
      tools: cachedTools,
      messages: [{ role: "user", content: [{ type: "text", text: "prefix" }] }],
    },
  });

  const toolInput: ToolCallingTaskInput = {
    model: "gemini-test",
    prompt: "run tool",
    tools: cachedTools,
    toolChoice: "auto",
  };

  it("retries inline once on a cache-scoped NOT_FOUND and evicts after the retry succeeds", async () => {
    const checkpointId = "not-found-tool";
    setGeminiCachedContent(checkpointId, {
      name: "cachedContents/tool",
      model: testModel,
      systemPrompt: undefined,
    });
    const requests: Record<string, unknown>[] = [];
    let call = 0;
    installGeminiClient({
      generateContentStream: async (request) => {
        requests.push(request);
        call += 1;
        if (call === 1) {
          // The entry is still present while the retry is being built —
          // eviction follows the retry, it does not precede it.
          expect(getGeminiCachedContent(checkpointId)).toBeDefined();
          throw cacheNotFoundError();
        }
        return { async *[Symbol.asyncIterator]() {} };
      },
    });
    const runFn = findGeminiRunFn("tool-use");
    await runFn(
      toolInput,
      testModel,
      new AbortController().signal,
      () => {},
      undefined,
      toolSession(checkpointId)
    );
    expect(requests).toHaveLength(2);
    expect((requests[0].config as Record<string, unknown>).cachedContent).toBe(
      "cachedContents/tool"
    );
    const retryConfig = requests[1].config as {
      cachedContent?: string;
      tools?: Array<Record<string, unknown>>;
    };
    expect(retryConfig.cachedContent).toBeUndefined();
    expect(retryConfig.tools).toBeDefined();
    // The cache-free retry succeeded, so the handle was the problem: evict it.
    expect(getGeminiCachedContent(checkpointId)).toBeUndefined();
  });

  it("keeps the entry when the cache-free retry also fails, and propagates the retry error", async () => {
    const checkpointId = "not-found-tool-retry-fails";
    setGeminiCachedContent(checkpointId, {
      name: "cachedContents/tool",
      model: testModel,
      systemPrompt: undefined,
    });
    const requests: Record<string, unknown>[] = [];
    let call = 0;
    installGeminiClient({
      generateContentStream: async (request) => {
        requests.push(request);
        call += 1;
        if (call === 1) throw cacheNotFoundError();
        throw Object.assign(new Error("backend unavailable"), { status: 500 });
      },
    });
    const runFn = findGeminiRunFn("tool-use");
    await expect(
      runFn(
        toolInput,
        testModel,
        new AbortController().signal,
        () => {},
        undefined,
        toolSession(checkpointId)
      )
    ).rejects.toMatchObject({ status: 500, message: "backend unavailable" });
    expect(requests).toHaveLength(2);
    expect((requests[1].config as Record<string, unknown>).cachedContent).toBeUndefined();
    // The handle was not what broke the call, so the still-valid entry stays
    // put instead of forcing every other consumer into a full re-encode.
    expect(getGeminiCachedContent(checkpointId)).toBeDefined();
  });

  it("does not retry or evict on a NOT_FOUND that is not scoped to the cache", async () => {
    const checkpointId = "not-found-tool-unscoped";
    setGeminiCachedContent(checkpointId, {
      name: "cachedContents/tool",
      model: testModel,
      systemPrompt: undefined,
    });
    const requests: Record<string, unknown>[] = [];
    installGeminiClient({
      generateContentStream: async (request) => {
        requests.push(request);
        throw Object.assign(new Error("cache not found"), { status: 404, code: "NOT_FOUND" });
      },
    });
    const runFn = findGeminiRunFn("tool-use");
    await expect(
      runFn(
        toolInput,
        testModel,
        new AbortController().signal,
        () => {},
        undefined,
        toolSession(checkpointId)
      )
    ).rejects.toMatchObject({ status: 404 });
    expect(requests).toHaveLength(1);
    expect(getGeminiCachedContent(checkpointId)).toBeDefined();
  });
});

describe("Gemini cachedContent proactive stale fallback", () => {
  it("skips the cached-content handle on a stale entry and does not re-issue", async () => {
    const checkpointId = "proactive-stale";
    // 3.6M ms > 3.5M default stale horizon
    setGeminiCachedContent(checkpointId, {
      name: "cachedContents/stale",
      model: testModel,
      systemPrompt: "sys",
      createdAtMs: Date.now() - 3_600_000,
    });
    const requests: Record<string, unknown>[] = [];
    installGeminiClient({
      generateContentStream: async (request) => {
        requests.push(request);
        return { async *[Symbol.asyncIterator]() {} };
      },
    });
    const runFn = findGeminiRunFn("text.generation");
    const input: TextGenerationTaskInput = { model: "gemini-test", prompt: "tail" };
    const session: AiSessionContext = {
      sessionId: checkpointId,
      prefix: {
        systemPrompt: "sys",
        messages: [{ role: "user", content: [{ type: "text", text: "prefix" }] }],
      },
    };
    await runFn(input, testModel, new AbortController().signal, () => {}, undefined, session);
    expect(requests).toHaveLength(1);
    expect((requests[0].config as Record<string, unknown>).cachedContent).toBeUndefined();
    expect(getGeminiCachedContent(checkpointId)).toBeUndefined();
  });
});
