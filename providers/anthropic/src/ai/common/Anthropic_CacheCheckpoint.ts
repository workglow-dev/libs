/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  AiSessionContext,
  CacheCheckpointTaskInput,
  CacheCheckpointTaskOutput,
  CheckpointPrefix,
  ToolDefinition,
} from "@workglow/ai";
import { buildToolDescription } from "@workglow/ai/worker";
import { getClient, getModelName } from "./Anthropic_Client";
import type { AnthropicModelConfig } from "./Anthropic_ModelSchema";
import { buildAnthropicMessages } from "./Anthropic_ToolCalling";
import { mapAnthropicUsage } from "./Anthropic_Usage";

/**
 * Maps workglow tool definitions onto Anthropic `tools` entries. The warm-up
 * and every consumer must encode tools through this one mapping — a divergent
 * encoding changes the serialized tool segment and breaks prompt-cache parity.
 */
export function toAnthropicTools(tools: readonly ToolDefinition[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    name: t.name,
    description: buildToolDescription(t),
    input_schema: t.inputSchema as Record<string, unknown>,
  }));
}

/** Replaces the last tool entry with a copy carrying a cache_control breakpoint. */
export function annotateLastTool(tools: Array<Record<string, unknown>>): void {
  if (tools.length === 0) return;
  tools[tools.length - 1] = {
    ...tools[tools.length - 1],
    cache_control: { type: "ephemeral" },
  };
}

/** Wraps a plain system prompt string into the annotated block form Anthropic caches. */
export function wrapSystemWithCacheControl(system: string): Array<Record<string, unknown>> {
  return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
}

/**
 * Places a cache_control breakpoint at the end of a message. Block-array
 * content annotates its last block; non-empty string content (the prompt-path
 * tail shape) is lifted into an annotated text block array. Empty content is
 * left alone — there is nothing cacheable to mark.
 */
export function annotateLastBlock(message: { content: unknown }): void {
  if (Array.isArray(message.content) && message.content.length > 0) {
    const blocks = message.content as Array<Record<string, unknown>>;
    blocks[blocks.length - 1] = {
      ...blocks[blocks.length - 1],
      cache_control: { type: "ephemeral" },
    };
  } else if (typeof message.content === "string" && message.content.length > 0) {
    message.content = [
      { type: "text", text: message.content, cache_control: { type: "ephemeral" } },
    ];
  }
}

/**
 * Builds the minimal messages.create params that write the given prefix into
 * Anthropic's server-side prompt cache: `max_tokens: 1`, cache_control on the
 * system block, the last tool, and the last prefix message block. A prefix
 * with no messages gets a throwaway user message (not annotated — the
 * system/tools breakpoints cover the cached content).
 */
export function buildAnthropicCheckpointParams(
  prefix: CheckpointPrefix,
  modelName: string
): Record<string, unknown> {
  const params: Record<string, unknown> = { model: modelName, max_tokens: 1 };
  if (prefix.systemPrompt) {
    params.system = wrapSystemWithCacheControl(prefix.systemPrompt);
  }
  if (prefix.tools && prefix.tools.length > 0) {
    const tools = toAnthropicTools(prefix.tools);
    annotateLastTool(tools);
    params.tools = tools;
    params.tool_choice = { type: "auto" };
  }
  // Guard on the CONVERTED array: buildAnthropicMessages skips system-role
  // entries, so a non-empty prefix.messages can still convert to [].
  const messages =
    prefix.messages && prefix.messages.length > 0
      ? buildAnthropicMessages(prefix.messages, "", undefined)
      : [];
  if (messages.length > 0) {
    annotateLastBlock(messages[messages.length - 1] as { content: unknown });
    params.messages = messages;
  } else {
    params.messages = [{ role: "user", content: [{ type: "text", text: "." }] }];
  }
  return params;
}

/**
 * Mutates consuming-call params to replay a checkpoint prefix: prepends the
 * prefix messages, applies the prefix system prompt (when the call has none),
 * replays the prefix tools (when the call declares none), and places
 * cache_control at the checkpoint boundary. When the call emits a chained
 * checkpoint, the final message block is annotated too so the next chained
 * call reads this turn from cache.
 */
export function applyAnthropicPrefixReplay(
  params: Record<string, unknown>,
  session: AiSessionContext
): void {
  const prefix = session.prefix;
  if (!prefix) return;

  if (prefix.systemPrompt && params.system === undefined) {
    params.system = wrapSystemWithCacheControl(prefix.systemPrompt);
  }

  // Consumers that declare no tools of their own replay the prefix's: tools
  // are the topmost segment of Anthropic's cache prefix, so omitting them
  // shares nothing with the warm-up, and replayed tool_use/tool_result blocks
  // are rejected outright without a tools param. tool_choice is left unset
  // (API default auto).
  const callerTools = params.tools;
  if (
    (!Array.isArray(callerTools) || callerTools.length === 0) &&
    prefix.tools &&
    prefix.tools.length > 0
  ) {
    const tools = toAnthropicTools(prefix.tools);
    annotateLastTool(tools);
    params.tools = tools;
  }

  // Guard on the CONVERTED array: buildAnthropicMessages skips system-role
  // entries, so a non-empty prefix.messages can still convert to [].
  const prefixMessages =
    prefix.messages && prefix.messages.length > 0
      ? buildAnthropicMessages(prefix.messages, "", undefined)
      : [];
  if (prefixMessages.length > 0) {
    annotateLastBlock(prefixMessages[prefixMessages.length - 1] as { content: unknown });
    const tail = Array.isArray(params.messages) ? (params.messages as unknown[]) : [];
    params.messages = [...prefixMessages, ...tail];
  }

  if (session.emitCheckpointId) {
    const messages = params.messages as Array<{ content: unknown }> | undefined;
    if (Array.isArray(messages) && messages.length > 0) {
      annotateLastBlock(messages[messages.length - 1]);
    }
  }
}

export const Anthropic_CacheCheckpoint_Stream: AiProviderRunFn<
  CacheCheckpointTaskInput,
  CacheCheckpointTaskOutput,
  AnthropicModelConfig
> = async (_input, model, signal, emit, _outputSchema, session) => {
  const prefix = session?.prefix ?? {};
  const client = await getClient(model);
  const params = buildAnthropicCheckpointParams(prefix, getModelName(model));
  const response = await (client.messages.create as (p: unknown, o: unknown) => Promise<unknown>)(
    params,
    { signal }
  );
  const usage = mapAnthropicUsage((response as { usage?: unknown } | undefined)?.usage);
  emit({
    type: "finish",
    data: { checkpoint: session?.sessionId ?? "" },
    ...(usage ? { usage } : {}),
  });
};
