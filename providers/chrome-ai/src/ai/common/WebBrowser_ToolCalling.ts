/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  ChatMessage,
  ToolCall,
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
} from "@workglow/ai";
import {
  buildToolDescription,
  compileToolValidators,
  filterValidToolCalls,
  sanitizeToolArgs,
  validateToolCallArgs,
} from "@workglow/ai";
import { uuid4 } from "@workglow/util";

import {
  buildInitialPromptsFromHistory,
  findLastUserIndex,
  flattenToolExchange,
  messageText,
} from "./WebBrowser_ChatHistory";
import {
  createDownloadMonitor,
  ensureAvailable,
  getApi,
  getChromeGlobal,
  snapshotStreamToTextDeltas,
} from "./WebBrowser_ChromeHelpers";
import type { WebBrowserModelConfig } from "./WebBrowser_ModelSchema";

function flattenPrompt(prompt: ToolCallingTaskInput["prompt"]): string {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((p) => {
      if (typeof p === "string") return p;
      const b = p as { type?: string; text?: string };
      return b.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/**
 * Build `initialPrompts` + the trailing prompt text from a {@link ToolCallingTaskInput}.
 *
 * When `input.messages` is present we treat the last user message as the
 * turn-in-progress; everything before it goes into `initialPrompts` via
 * {@link buildInitialPromptsFromHistory}.
 *
 * Everything AFTER it is this turn's tool exchange — the assistant `tool_use`
 * an orchestrator recorded and the `tool_result` it fed back. Chrome's surface
 * has no frame for either, so {@link flattenToolExchange} folds them into the
 * prompt text instead of letting them fall on the floor: a second round whose
 * request is byte-identical to the first is a model asking for the same tool
 * until the rounds run out.
 */
function buildToolCallPrompt(input: ToolCallingTaskInput): {
  initialPrompts: LanguageModelCreateOptions["initialPrompts"];
  promptText: string;
} {
  const hasMessages = Array.isArray(input.messages) && input.messages.length > 0;
  if (hasMessages) {
    const messages = input.messages as readonly ChatMessage[];
    const lastUserIdx = findLastUserIndex(messages);
    if (lastUserIdx < 0) {
      return {
        initialPrompts: buildInitialPromptsFromHistory([], input.systemPrompt).initialPrompts,
        promptText: flattenPrompt(input.prompt),
      };
    }
    const { initialPrompts } = buildInitialPromptsFromHistory(
      messages.slice(0, lastUserIdx),
      input.systemPrompt
    );
    const exchange = flattenToolExchange(messages.slice(lastUserIdx + 1));
    const userText = messageText(messages[lastUserIdx]);
    return {
      initialPrompts,
      promptText: exchange.length === 0 ? userText : `${userText}\n\n${exchange}`,
    };
  }

  const initialPrompts: LanguageModelCreateOptions["initialPrompts"] = input.systemPrompt
    ? [{ role: "system", content: input.systemPrompt }]
    : [];
  return { initialPrompts, promptText: flattenPrompt(input.prompt) };
}

/**
 * Streaming run-fn for `["text.generation", "tool-use"]`.
 *
 * Chrome's Prompt API runs the tool-calling loop **inside** `prompt()`: the
 * model decides to invoke a tool, Chrome calls the tool's `execute(args)`
 * callback, awaits the returned string, and feeds that string back into the
 * model as the tool result. To bridge into workglow's protocol — where the
 * task graph executes tools externally and the run-fn returns the requested
 * calls — we install stub tools whose `execute` captures the args, returns
 * an empty placeholder, and lets Chrome's loop continue. The model may make
 * multiple calls and generate text either before, between, or after them;
 * everything is captured, then emitted at the end.
 *
 * **Trade-off**: text generated *after* a tool call is reasoning over our
 * empty placeholder rather than real tool output, so it's likely junk. The
 * orchestrator's next turn (with real tool results re-fed via `messages`)
 * is what produces the useful follow-up text — this turn's role is to
 * extract the tool intent, not to converse.
 *
 * `temperature` is `@deprecated` for non-extension contexts in the current
 * Chrome spec and silently ignored on the open web. Passed through anyway
 * so extension callers still get the knob.
 *
 * We intentionally create a fresh Chrome session for every turn. Chrome's
 * internal tool loop appends tool-result state opaquely, so cross-turn reuse
 * would double-feed tool results once the orchestrator also supplies them via
 * `messages`.
 *
 * ## Argument validation
 *
 * Chrome calls `execute` with `(args)` where `args[0]` is whatever the
 * model produced. The model can hallucinate fields that don't match the
 * tool's `inputSchema`. We compile each tool's schema once, validate the
 * captured arguments before passing them to `filterValidToolCalls`, and
 * drop+log calls that fail. Tools whose `inputSchema` fails to compile
 * fall through to name-only validation with a single warning so a
 * malformed schema doesn't crash the run.
 *
 * Captured args are also passed through {@link sanitizeToolArgs} before
 * validation to scrub `__proto__` / `constructor` / `prototype` keys.
 */
export const WebBrowser_ToolCalling: AiProviderRunFn<
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  WebBrowserModelConfig
> = async (input, _model, signal, emit, _outputSchema, _sessionContext) => {
  const factory = getApi("LanguageModel", getChromeGlobal<typeof LanguageModel>("LanguageModel"));
  await ensureAvailable("LanguageModel", factory);

  const capturedCalls: ToolCall[] = [];

  // Compile validators once per tool. A bad schema downgrades that tool
  // to name-only validation rather than failing the whole run — the
  // existing `filterValidToolCalls` name check is still applied below.
  const validators = compileToolValidators(input.tools);

  // `toolChoice: "none"` → omit tools entirely so the model can't call any.
  // Specific tool-name choices aren't expressible in Chrome's surface; we
  // pass all tools and let the model decide.
  const chromeTools: LanguageModelTool[] =
    input.toolChoice === "none"
      ? []
      : input.tools.map((td) => ({
          name: td.name,
          description: buildToolDescription(td),
          inputSchema: td.inputSchema as object,
          execute: async (...args: unknown[]): Promise<string> => {
            // If the user aborted mid-loop, short-circuit without capturing
            // — the surrounding `promptStreaming` will throw on its next
            // read and the finally below will tear down the session.
            if (signal?.aborted) return "";
            const raw = (args[0] ?? {}) as Record<string, unknown>;
            // Sanitize BEFORE validation so the validator sees a clean,
            // Object.prototype-only object. Tool schemas without
            // `additionalProperties: false` would otherwise let prototype-
            // pollution payloads pass through.
            const callInput = sanitizeToolArgs(raw) as Record<string, unknown>;
            capturedCalls.push({ id: uuid4(), name: td.name, input: callInput });
            return "";
          },
        }));

  const { initialPrompts, promptText } = buildToolCallPrompt(input);
  const session = await factory.create({
    signal,
    temperature: input.temperature ?? undefined,
    tools: chromeTools.length > 0 ? chromeTools : undefined,
    initialPrompts,
    monitor: createDownloadMonitor(emit),
  });
  try {
    const stream = session.promptStreaming(promptText, { signal });
    // The helper emits text-delta only; we emit the composite finish below
    // (text + toolCalls) after validating the captured calls.
    await snapshotStreamToTextDeltas<ToolCallingTaskOutput>(stream, "text", emit);

    // Validate each captured call's `input` against its tool's compiled
    // schema, then apply name-only defence in depth.
    const argValidated = validateToolCallArgs(capturedCalls, validators);
    const validated = filterValidToolCalls(argValidated, input.tools);
    if (validated.length > 0) {
      emit({ type: "object-delta", port: "toolCalls", objectDelta: validated });
    }
    emit({ type: "finish", data: {} as ToolCallingTaskOutput });
  } finally {
    try {
      session.destroy();
    } catch {
      // best-effort
    }
  }
};
