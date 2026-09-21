/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatMessage, ContentBlockInToolResultBody } from "@workglow/ai";
import { canonicalStringify } from "./WebBrowser_ChromeHelpers";

/**
 * Shared mapping helpers between {@link WebBrowser_Chat} and
 * {@link WebBrowser_ToolCalling}. Chrome's open-web Prompt API surface is
 * system/user/assistant + text/image/audio. Both run-fns convert workglow
 * {@link ChatMessage}s into the Chrome `LanguageModelMessage` /
 * `LanguageModelSystemMessage` shape using these helpers — text-only, with
 * tool messages and structured tool_use/tool_result content blocks dropped.
 */

/** Concatenate a message's text-typed content blocks; non-text blocks are dropped. */
export function messageText(msg: ChatMessage): string {
  return msg.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/**
 * Renders the tool exchange that followed a turn's last user message as text.
 *
 * Chrome's prompt surface carries system/user/assistant text and nothing else,
 * so an assistant `tool_use` and the `tool_result` answering it have no frame
 * to travel in. Dropped, the next round's request is identical to the one that
 * asked for the tool, so the model asks for the same tool again — for every
 * round the orchestrator allows, re-running it each time and answering nothing.
 * Folded into the prompt as prose, the model reads what its call returned.
 */
/** What a `tool_result` renders as when it carried no content at all. */
const NO_CONTENT = "(no content returned)";

/**
 * Names a tool-result block this prose surface cannot carry.
 *
 * Rendered as the empty string, a tool that returned an image would tell the
 * model it returned nothing — which is indistinguishable from a tool that
 * genuinely produced nothing, and is the input most likely to make a model
 * call the tool again. The marker says the call succeeded and what came back,
 * so the model can answer from it or stop rather than retry.
 */
function describeNonText(block: ContentBlockInToolResultBody): string {
  if (block.type === "image") {
    return `[image content (${block.mimeType}), not representable in this prompt]`;
  }
  if (block.type === "tool_use") {
    return `[nested tool call ${block.name}, not representable in this prompt]`;
  }
  return "[content not representable in this prompt]";
}

export function flattenToolExchange(tail: readonly ChatMessage[]): string {
  const names = new Map<string, string>();
  const lines: string[] = [];
  for (const msg of tail) {
    for (const block of msg.content) {
      if (block.type === "text") {
        if (block.text.length > 0) lines.push(block.text);
      } else if (block.type === "tool_use") {
        names.set(block.id, block.name);
        lines.push(`Tool call: ${block.name}(${canonicalStringify(block.input)})`);
      } else if (block.type === "tool_result") {
        const name = names.get(block.tool_use_id) ?? "tool";
        const body = block.content
          .map((inner) => (inner.type === "text" ? inner.text : describeNonText(inner)))
          .filter((s) => s.length > 0)
          .join("\n");
        const label = block.is_error === true ? "Tool error from" : "Tool result from";
        lines.push(
          body.length > 0 ? `${label} ${name}: ${body}` : `${label} ${name}: ${NO_CONTENT}`
        );
      }
    }
  }
  return lines.join("\n\n");
}

/** Index of the last `role: "user"` message, or `-1` if none. */
export function findLastUserIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

export interface ChromeInitialPromptState {
  readonly initialPrompts: LanguageModelCreateOptions["initialPrompts"];
  readonly fingerprint: string;
}

/**
 * Build the `initialPrompts` array for `LanguageModel.create()` from a slice
 * of conversation history.
 *
 * Chrome models the system message as a distinct `LanguageModelSystemMessage`
 * type that may only appear as the first element of `initialPrompts`. Every
 * other entry is user/assistant via `LanguageModelMessage`. We take at most
 * the first leading system message; later system messages (rare) are
 * dropped to keep the IDL constraint satisfied. Tool-role messages and
 * empty messages are also dropped.
 *
 * `systemPrompt` is the caller's own, used only when the history carries no
 * leading system message. A task that states its instructions on a separate
 * port would otherwise lose them the moment it also sends a history.
 */
export function buildInitialPromptsFromHistory(
  history: readonly ChatMessage[],
  systemPrompt?: string | undefined
): ChromeInitialPromptState {
  const tail: LanguageModelMessage[] = [];
  let leadingSystem: LanguageModelSystemMessage | undefined;

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    const text = messageText(msg);
    if (text.length === 0) continue;
    if (msg.role === "system") {
      if (i === 0 && leadingSystem === undefined) {
        leadingSystem = { role: "system", content: text };
      }
      continue;
    }
    if (msg.role === "user" || msg.role === "assistant") {
      tail.push({ role: msg.role, content: text });
    }
  }

  const system =
    leadingSystem ??
    (systemPrompt !== undefined && systemPrompt.length > 0
      ? ({ role: "system", content: systemPrompt } satisfies LanguageModelSystemMessage)
      : undefined);
  const initialPrompts: LanguageModelCreateOptions["initialPrompts"] =
    system === undefined
      ? tail.length === 0
        ? []
        : tail
      : ([system, ...tail] as [LanguageModelSystemMessage, ...LanguageModelMessage[]]);
  return {
    initialPrompts,
    fingerprint: canonicalStringify(initialPrompts),
  };
}
