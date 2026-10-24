/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ScriptedReply, WireTurn } from "@workglow/test-contract/ai-provider";
import { runToolTurnConformance } from "@workglow/test-contract/ai-provider";

import { proseToolExchangeTurns } from "./proseToolExchangeWire";
import { runFnFor } from "./WebBrowser.test-utils";

const model = {
  model_id: "chrome-conformance",
  provider: "WEB_BROWSER",
  provider_config: { pipeline: "text-generation" },
} as never;

/** What one `prompt()` reads: the session's `initialPrompts`, then the prompt text. */
interface PromptApiRequest {
  readonly initialPrompts: ReadonlyArray<{
    readonly role: WireTurn["role"];
    readonly content: string;
  }>;
  readonly prompt: string;
}

interface ScriptedTool {
  readonly name: string;
  readonly execute: (...args: unknown[]) => Promise<string>;
}

/**
 * The tool exchange rides inside the prompt text as prose (Chrome's surface has
 * no frame for a call or its result), so the prompt is split into turns by the
 * labels the run-fn writes on it.
 */
function turns(request: unknown): WireTurn[] {
  const { initialPrompts, prompt } = request as PromptApiRequest;
  return [
    ...initialPrompts.map((message) => ({ role: message.role, body: message })),
    ...proseToolExchangeTurns(prompt),
  ];
}

/**
 * A `LanguageModel` global whose sessions answer from the script the way
 * Chrome's own loop does: it invokes each tool's `execute` for the calls the
 * model makes, inside `prompt()`, then streams the answer text. The Prompt API
 * has no reasoning channel, so a scripted reply's reasoning has nowhere to go.
 */
function scriptedLanguageModel(sent: PromptApiRequest[], replies: ScriptedReply[]): unknown {
  return {
    availability: async () => "available",
    create: async (options: {
      readonly initialPrompts?: PromptApiRequest["initialPrompts"];
      readonly tools?: ReadonlyArray<ScriptedTool>;
    }) => ({
      promptStreaming: (prompt: string) => {
        sent.push(
          JSON.parse(JSON.stringify({ initialPrompts: options.initialPrompts ?? [], prompt }))
        );
        const reply = replies.shift() ?? {};
        return new ReadableStream<string>({
          async start(controller) {
            for (const call of reply.toolCalls ?? []) {
              const tool = options.tools?.find((candidate) => candidate.name === call.name);
              await tool?.execute(call.input);
            }
            if (reply.text !== undefined) controller.enqueue(reply.text);
            controller.close();
          },
        });
      },
      destroy: () => {},
    }),
  };
}

runToolTurnConformance({
  name: "Chrome AI",
  createHarness: () => {
    const sent: PromptApiRequest[] = [];
    const replies: ScriptedReply[] = [];
    const global = globalThis as { LanguageModel?: unknown };
    const previous = global.LanguageModel;
    global.LanguageModel = scriptedLanguageModel(sent, replies);
    const runFn = runFnFor(["text.generation", "tool-use"]);
    return {
      respond: (reply) => void replies.push(reply),
      run: (request, emit) =>
        runFn(
          { ...request, toolChoice: "auto" } as never,
          model,
          new AbortController().signal,
          emit as never
        ),
      sent: () => sent,
      dispose: () => {
        global.LanguageModel = previous;
      },
    };
  },
  turns,
  reasoningStream: {
    notForwarded:
      "the Prompt API streams the answer text only; whatever the on-device model thinks never reaches the page",
  },
  reasoningReplay: {
    kind: "none",
    reason: "the Prompt API returns no reasoning, so a round has none to carry forward",
  },
  toolResultImages: {
    kind: "text-only",
    reason:
      "a tool exchange reaches the Prompt API only as prose in the prompt text, where an image is named rather than sent",
  },
});
