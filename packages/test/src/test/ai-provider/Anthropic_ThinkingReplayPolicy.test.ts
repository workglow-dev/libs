/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, AiSessionContext } from "@workglow/ai";
import { ANTHROPIC, _testOnly } from "@workglow/anthropic/ai";
import {
  buildAnthropicCheckpointParams,
  _testOnly as runtimeTestOnly,
} from "@workglow/anthropic/ai-runtime";
import { getLogger } from "@workglow/util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  ANTHROPIC_RUN_FNS,
  setAnthropicClientForTests,
  requestAllowsThinkingReplay,
  isThinkingSignatureError,
  THINKING_SIGNATURE_ERROR_TEXT,
} = _testOnly;

/** A generation-4 id: it accepts a forced tool choice, so the choice is sent as asked. */
const MODEL_NAME = "claude-haiku-4-5";
const NATIVE_KEY = `anthropic:${MODEL_NAME}`;

type ThinkingSetting = "unset" | "disabled" | "enabled" | "adaptive";
type EffortSetting = "set" | "unset";
type ChoiceSetting = "auto" | "any" | "tool";

const THINKING: Record<ThinkingSetting, Record<string, unknown> | undefined> = {
  unset: undefined,
  disabled: { type: "disabled" },
  enabled: { type: "enabled", budget_tokens: 2048 },
  adaptive: { type: "adaptive" },
};

/** The `toolChoice` input that maps to each Anthropic `tool_choice` type. */
const CHOICE_INPUT: Record<ChoiceSetting, string | undefined> = {
  auto: undefined,
  any: "required",
  tool: "look",
};

function modelWith(thinking: ThinkingSetting, effort: EffortSetting): never {
  return {
    model_id: MODEL_NAME,
    title: "",
    description: "",
    provider: ANTHROPIC,
    provider_config: {
      model_name: MODEL_NAME,
      api_key: "test-key",
      ...(THINKING[thinking] !== undefined ? { thinking: THINKING[thinking] } : {}),
      ...(effort === "set" ? { output_config: { effort: "high" } } : {}),
    },
    capabilities: ["text.generation", "tool-use"],
    metadata: {},
  } as never;
}

const signedBlocks = [
  { type: "thinking", thinking: "Plan", signature: "SIG" },
  { type: "tool_use", id: "t1", name: "look", input: { a: 1 } },
];

/** A round this model answered with signed thinking, then its tool result. */
const signedTurn = (provider: string) => [
  { role: "user", content: [{ type: "text", text: "go" }] },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "", provider, payload: JSON.stringify(signedBlocks) },
      { type: "tool_use", id: "t1", name: "look", input: { a: 1 } },
    ],
  },
  {
    role: "tool",
    content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }],
  },
];

const lookTool = [
  { name: "look", description: "", inputSchema: { type: "object", properties: {} } },
];

/** The API's message for a thinking block bound to a different conversation. */
const BINDING_MESSAGE =
  'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header.';

/**
 * The fields the SDK's `APIError.generate` sets for a 400: the response body
 * on `error`, its `error.type` on `type`, and `"<status> <body JSON>"` as the
 * message when the body has no top-level `message`.
 */
function sdkBadRequest(type: string, message: string): Error {
  const body = { type: "error", error: { type, message }, request_id: "req_1" };
  return Object.assign(new Error(`400 ${JSON.stringify(body)}`), {
    status: 400,
    error: body,
    type,
  });
}

const hasThinking = (messages: Array<{ role: string; content: unknown }>): boolean =>
  messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as Array<{ type?: string }>).some(
        (b) => b.type === "thinking" || b.type === "redacted_thinking"
      )
  );

function runFnServing(capability: string): AiProviderRunFn {
  const registration = ANTHROPIC_RUN_FNS.find(({ serves }) =>
    (serves as readonly string[]).includes(capability)
  );
  expect(registration).toBeDefined();
  return registration!.runFn as AiProviderRunFn;
}

/**
 * Whether signed thinking may go out, per setting, as Anthropic answers it:
 * explicitly disabled thinking takes none; absent thinking takes them only when
 * effort is set (a Claude 5+ model thinks then); legacy `enabled` is dropped
 * from a forced choice, effort included, so that request runs without thinking.
 */
function expectedReplay(
  thinking: ThinkingSetting,
  effort: EffortSetting,
  choice: ChoiceSetting
): boolean {
  switch (thinking) {
    case "adaptive":
      return true;
    case "disabled":
      return false;
    case "enabled":
      return choice === "auto";
    case "unset":
      return effort === "set";
  }
}

const THINKING_SETTINGS: readonly ThinkingSetting[] = ["unset", "disabled", "enabled", "adaptive"];
const EFFORT_SETTINGS: readonly EffortSetting[] = ["set", "unset"];
const CHOICE_SETTINGS: readonly ChoiceSetting[] = ["auto", "any", "tool"];

const TOOL_CALLING_TABLE = THINKING_SETTINGS.flatMap((thinking) =>
  EFFORT_SETTINGS.flatMap((effort) =>
    CHOICE_SETTINGS.map(
      (choice) => [thinking, effort, choice, expectedReplay(thinking, effort, choice)] as const
    )
  )
);

/** The checkpoint warm-up always declares `tool_choice: auto`. */
const CHECKPOINT_TABLE = THINKING_SETTINGS.flatMap((thinking) =>
  EFFORT_SETTINGS.map(
    (effort) => [thinking, effort, expectedReplay(thinking, effort, "auto")] as const
  )
);

describe("Anthropic thinking replay policy", () => {
  let calls: Array<Record<string, any>>;
  let script: Array<readonly unknown[] | Error>;

  beforeEach(() => {
    calls = [];
    script = [];
    vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const fakeClient = {
      messages: {
        stream: (params: Record<string, unknown>) => {
          calls.push(structuredClone(params));
          const next = script.shift() ?? [];
          if (next instanceof Error) throw next;
          return {
            async *[Symbol.asyncIterator]() {
              for (const event of next) {
                if (event instanceof Error) throw event;
                yield event;
              }
            },
          };
        },
      },
    };
    setAnthropicClientForTests(fakeClient);
    runtimeTestOnly.setAnthropicClientForTests?.(fakeClient);
  });

  afterEach(() => {
    setAnthropicClientForTests(undefined);
    runtimeTestOnly.setAnthropicClientForTests?.(undefined);
    vi.restoreAllMocks();
  });

  describe("tool calling", () => {
    it.each(TOOL_CALLING_TABLE)(
      "thinking %s, effort %s, tool_choice %s: signed blocks sent = %s",
      async (thinking, effort, choice, sent) => {
        const model = modelWith(thinking, effort);
        await runFnServing("tool-use")(
          {
            model,
            prompt: "",
            messages: signedTurn(NATIVE_KEY),
            tools: lookTool,
            toolChoice: CHOICE_INPUT[choice],
          } as never,
          model,
          undefined as never,
          (() => {}) as never
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]!.tool_choice.type).toBe(choice);
        expect(requestAllowsThinkingReplay(calls[0]!)).toBe(sent);
        const assistant = (calls[0]!.messages as Array<{ role: string; content: unknown }>).find(
          (m) => m.role === "assistant"
        )!;
        expect(assistant.content).toEqual(
          sent ? signedBlocks : [{ type: "tool_use", id: "t1", name: "look", input: { a: 1 } }]
        );
      }
    );

    it("removes a checkpoint prefix's signed thinking from a request without thinking", async () => {
      const model = modelWith("disabled", "unset");
      const session: AiSessionContext = {
        sessionId: "ckpt",
        prefix: { messages: signedTurn(NATIVE_KEY) as never },
      };
      await runFnServing("tool-use")(
        { model, prompt: "tail", tools: lookTool } as never,
        model,
        undefined as never,
        (() => {}) as never,
        undefined,
        session
      );
      expect(calls).toHaveLength(1);
      expect(hasThinking(calls[0]!.messages)).toBe(false);
      expect(calls[0]!.messages).toHaveLength(4);
    });

    it("keeps a checkpoint prefix's signed thinking on a request with thinking", async () => {
      const model = modelWith("adaptive", "unset");
      await runFnServing("tool-use")(
        { model, prompt: "tail", tools: lookTool } as never,
        model,
        undefined as never,
        (() => {}) as never,
        undefined,
        { sessionId: "ckpt", prefix: { messages: signedTurn(NATIVE_KEY) as never } }
      );
      expect(hasThinking(calls[0]!.messages)).toBe(true);
    });

    it("retries once without thinking on an SDK-shaped signature 400", async () => {
      script = [sdkBadRequest("invalid_request_error", BINDING_MESSAGE), []];
      const model = modelWith("adaptive", "unset");
      await runFnServing("tool-use")(
        { model, prompt: "", messages: signedTurn(NATIVE_KEY), tools: lookTool } as never,
        model,
        undefined as never,
        (() => {}) as never
      );
      expect(calls).toHaveLength(2);
      expect(hasThinking(calls[0]!.messages)).toBe(true);
      expect(hasThinking(calls[1]!.messages)).toBe(false);
    });
  });

  describe("checkpoint warm-up", () => {
    it.each(CHECKPOINT_TABLE)(
      "thinking %s, effort %s: signed blocks sent = %s",
      (thinking, effort, sent) => {
        const params = buildAnthropicCheckpointParams(
          { tools: lookTool as never, messages: signedTurn(NATIVE_KEY) as never },
          MODEL_NAME,
          modelWith(thinking, effort)
        );
        expect(params.tool_choice).toEqual({ type: "auto" });
        expect(requestAllowsThinkingReplay(params)).toBe(sent);
        expect(hasThinking(params.messages as never)).toBe(sent);
      }
    );

    it("keeps the replay when no model says what the thinking fields are", () => {
      const params = buildAnthropicCheckpointParams(
        { messages: signedTurn(NATIVE_KEY) as never },
        MODEL_NAME
      );
      expect(hasThinking(params.messages as never)).toBe(true);
    });
  });

  describe("text generation", () => {
    const run = async (model: never): Promise<Array<Record<string, any>>> => {
      const events: Array<Record<string, any>> = [];
      await runFnServing("text.generation")(
        { model, prompt: "tail" } as never,
        model,
        undefined as never,
        ((event: Record<string, any>) => events.push(event)) as never,
        undefined,
        { sessionId: "ckpt", prefix: { messages: signedTurn(NATIVE_KEY) as never } }
      );
      return events;
    };

    it("removes a checkpoint prefix's signed thinking from a request without thinking", async () => {
      await run(modelWith("unset", "unset"));
      expect(calls).toHaveLength(1);
      expect(hasThinking(calls[0]!.messages)).toBe(false);
    });

    it("replays a checkpoint prefix's signed thinking on a request with thinking", async () => {
      await run(modelWith("adaptive", "unset"));
      expect(hasThinking(calls[0]!.messages)).toBe(true);
    });

    it("strips thinking and retries once when Anthropic rejects the replayed signature", async () => {
      script = [
        sdkBadRequest("invalid_request_error", BINDING_MESSAGE),
        [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }],
      ];
      const events = await run(modelWith("adaptive", "unset"));
      expect(calls).toHaveLength(2);
      expect(hasThinking(calls[0]!.messages)).toBe(true);
      expect(hasThinking(calls[1]!.messages)).toBe(false);
      expect(events).toContainEqual({ type: "text-delta", port: "text", textDelta: "hi" });
      expect(events.filter((e) => e.type === "finish")).toHaveLength(1);
      expect(getLogger().warn).toHaveBeenCalledWith(
        "Anthropic rejected replayed thinking; retrying without it.",
        { model: MODEL_NAME }
      );
    });

    it("does not loop: a second rejection is rethrown", async () => {
      script = [
        sdkBadRequest("invalid_request_error", BINDING_MESSAGE),
        sdkBadRequest("invalid_request_error", BINDING_MESSAGE),
      ];
      await expect(run(modelWith("adaptive", "unset"))).rejects.toThrow(/Invalid `signature`/);
      expect(calls).toHaveLength(2);
    });

    it("does not retry after output reached the consumer", async () => {
      script = [
        [
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "part" } },
          sdkBadRequest("invalid_request_error", BINDING_MESSAGE),
        ],
      ];
      await expect(run(modelWith("adaptive", "unset"))).rejects.toThrow(/Invalid `signature`/);
      expect(calls).toHaveLength(1);
    });
  });
});

describe("requestAllowsThinkingReplay", () => {
  it.each([
    [{}, false],
    [{ output_config: { effort: "low" } }, true],
    [{ output_config: { format: { type: "json_schema" } } }, false],
    [{ thinking: { type: "disabled" } }, false],
    [{ thinking: { type: "disabled" }, output_config: { effort: "high" } }, false],
    [{ thinking: { type: "enabled", budget_tokens: 1024 } }, true],
    [{ thinking: { type: "adaptive" } }, true],
    [{ thinking: { type: "between_tools" } }, true],
  ] as const)("%j allows replay: %s", (params, allowed) => {
    expect(requestAllowsThinkingReplay(params)).toBe(allowed);
  });
});

describe("isThinkingSignatureError", () => {
  it("pins the clause it recognises against the API's message", () => {
    expect(THINKING_SIGNATURE_ERROR_TEXT).toBe("Invalid `signature` in `thinking` block");
    expect(BINDING_MESSAGE).toContain(THINKING_SIGNATURE_ERROR_TEXT);
  });

  it("recognises the SDK's BadRequestError by its type and body message", () => {
    expect(isThinkingSignatureError(sdkBadRequest("invalid_request_error", BINDING_MESSAGE))).toBe(
      true
    );
  });

  it("recognises a tampered signature, which carries the clause alone", () => {
    const tampered = "messages.1.content.0: Invalid `signature` in `thinking` block";
    expect(isThinkingSignatureError(sdkBadRequest("invalid_request_error", tampered))).toBe(true);
  });

  it("refuses a 400 of another error type even when the message matches", () => {
    expect(isThinkingSignatureError(sdkBadRequest("api_error", BINDING_MESSAGE))).toBe(false);
  });

  it("refuses an invalid request about something else", () => {
    expect(
      isThinkingSignatureError(sdkBadRequest("invalid_request_error", "max_tokens: too large"))
    ).toBe(false);
  });

  it("reads the type from the body when the error carries no type of its own", () => {
    const body = { type: "error", error: { type: "api_error", message: BINDING_MESSAGE } };
    const err = Object.assign(new Error(BINDING_MESSAGE), { status: 400, error: body });
    expect(isThinkingSignatureError(err)).toBe(false);
  });

  it("falls back to the message of an error without a type", () => {
    const err = Object.assign(new Error(BINDING_MESSAGE), { status: 400 });
    expect(isThinkingSignatureError(err)).toBe(true);
  });

  it("refuses any status but 400, and anything that is not an error object", () => {
    const err = Object.assign(new Error(BINDING_MESSAGE), { status: 500 });
    expect(isThinkingSignatureError(err)).toBe(false);
    expect(isThinkingSignatureError(BINDING_MESSAGE)).toBe(false);
    expect(isThinkingSignatureError(undefined)).toBe(false);
  });
});
