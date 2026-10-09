/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly as hfiTestOnly } from "@workglow/huggingface-inference/ai";
import { _testOnly as openRouterTestOnly } from "@workglow/openrouter/ai";
import { _testOnly as xaiTestOnly } from "@workglow/xai/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function findRunFn(
  fns: readonly { readonly serves: readonly string[]; readonly runFn: any }[],
  label: string
) {
  const reg = fns.find((r) => [...r.serves].sort().join(",") === "text.generation,tool-use");
  if (!reg) throw new Error(`no ${label} tool-calling run-fn registered`);
  return reg.runFn;
}

const input = {
  prompt: "look",
  tools: [{ name: "shot", description: "", inputSchema: { type: "object", properties: {} } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "look" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "shot", input: {} }] },
    {
      role: "tool",
      content: [
        {
          type: "tool_result",
          tool_use_id: "c1",
          content: [
            { type: "text", text: "here" },
            { type: "image", mimeType: "image/png", data: "AAAA" },
          ],
        },
      ],
    },
  ],
} as any;

function expectImageInFollowingUserMessage(messages: any[]): void {
  const toolIndex = messages.findIndex((m) => m.role === "tool");
  expect(toolIndex).toBeGreaterThan(-1);
  const toolMessage = messages[toolIndex];
  expect(typeof toolMessage.content).toBe("string");
  expect(toolMessage.content).toContain("image(s) from this result follow");

  const next = messages[toolIndex + 1];
  expect(next.role).toBe("user");
  expect(next.content).toContainEqual({
    type: "image_url",
    image_url: { url: "data:image/png;base64,AAAA" },
  });
}

function sseEmptyResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("tool-result images reach the model in a user message", () => {
  describe("over the openai SDK (xAI, OpenRouter)", () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, "fetch");
      fetchSpy.mockImplementation(async () => sseEmptyResponse());
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    function sentMessages(): any[] {
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      return JSON.parse(init.body as string).messages;
    }

    it("xAI", async () => {
      const runFn = findRunFn(xaiTestOnly.XAI_RUN_FNS, "xAI");
      await runFn(
        input,
        {
          model_id: "grok-x",
          provider_config: { model_name: "grok-4", api_key: "test-key" },
        } as any,
        new AbortController().signal,
        () => {}
      );
      expectImageInFollowingUserMessage(sentMessages());
    });

    it("OpenRouter", async () => {
      const runFn = findRunFn(openRouterTestOnly.OPENROUTER_RUN_FNS, "OpenRouter");
      await runFn(
        input,
        {
          model_id: "openrouter-x",
          provider_config: { model_name: "anthropic/claude-sonnet-4", api_key: "test-key" },
        } as any,
        new AbortController().signal,
        () => {}
      );
      expectImageInFollowingUserMessage(sentMessages());
    });
  });

  describe("Hugging Face Inference", () => {
    let captured: any;

    beforeEach(() => {
      captured = undefined;
      class FakeInferenceClient {
        chatCompletionStream(params: unknown) {
          captured = params;
          return (async function* () {})();
        }
      }
      hfiTestOnly._setHfInferenceSDKForTesting({ InferenceClient: FakeInferenceClient } as any);
    });

    afterEach(() => {
      hfiTestOnly._setHfInferenceSDKForTesting(undefined);
    });

    it("sends the image in a user message", async () => {
      const runFn = findRunFn(hfiTestOnly.HFI_RUN_FNS, "Hugging Face Inference");
      await runFn(
        input,
        {
          model_id: "hfi-x",
          provider_config: { model_name: "meta-llama/Llama-3.3-70B-Instruct", api_key: "test-key" },
        } as any,
        new AbortController().signal,
        () => {}
      );
      expectImageInFollowingUserMessage(captured.messages);
    });
  });
});
