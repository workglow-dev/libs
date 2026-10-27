/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Usage } from "@workglow/ai";
import { estimateCallUsage } from "@workglow/ai/provider-utils";

/**
 * The context measures a Prompt API session may carry. Read structurally: the
 * names moved (`inputUsage` → `contextUsage`, `measureInputUsage` →
 * `measureContextUsage`) and a given Chrome has one pair, the other or neither.
 */
interface MeasurableSession {
  readonly contextUsage?: unknown;
  readonly inputUsage?: unknown;
  readonly measureContextUsage?: unknown;
  readonly measureInputUsage?: unknown;
}

type MeasureFn = (input: string, options?: { signal?: AbortSignal }) => Promise<unknown>;

/**
 * Prompt tokens a request to `session` will send, by the on-device model's own
 * tokenizer: what the session already holds (system prompt, history, tool
 * declarations) plus `promptText`. Called BEFORE prompting, since the session's
 * count grows by the prompt and the reply once it runs. Undefined where this
 * Chrome exposes neither measure or measuring fails, so the caller estimates.
 */
export async function measurePromptTokens(
  session: object,
  promptText: string,
  signal: AbortSignal | undefined
): Promise<number | undefined> {
  const measurable = session as MeasurableSession;
  const held = measurable.contextUsage ?? measurable.inputUsage;
  const measure = (measurable.measureContextUsage ?? measurable.measureInputUsage) as
    | MeasureFn
    | undefined;
  if (typeof held !== "number" || typeof measure !== "function") return undefined;
  try {
    const prompt = await measure.call(session, promptText, signal ? { signal } : undefined);
    return typeof prompt === "number" && Number.isFinite(prompt) ? held + prompt : undefined;
  } catch {
    // Advisory: a failed measurement must not fail the call it describes.
    return undefined;
  }
}

/**
 * The usage of one Prompt API call, for its `finish` event. Chrome reports no
 * token counts, so the output is estimated from the text the call ended with,
 * and the input is the session's own measure when there was one, else
 * estimated from every text the session was given (`promptParts`).
 */
export function chromeCallUsage(
  measuredPrompt: number | undefined,
  promptParts: readonly string[],
  outputText: string
): Usage | undefined {
  return estimateCallUsage(measuredPrompt ?? promptParts.join("\n"), outputText);
}

/** The text of a session's `initialPrompts`, for estimating the prompt when it cannot be measured. */
export function initialPromptTexts(
  initialPrompts: LanguageModelCreateOptions["initialPrompts"]
): string[] {
  const texts: string[] = [];
  for (const message of initialPrompts ?? []) {
    if (typeof message.content === "string") {
      texts.push(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text" && typeof part.value === "string") texts.push(part.value);
    }
  }
  return texts;
}
