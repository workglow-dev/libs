/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatMessage } from "@workglow/ai";
import { getLogger } from "@workglow/util/worker";
import type { AnthropicModelConfig } from "./Anthropic_ModelSchema";
import { parsedModelName } from "./Anthropic_RequestParams";
import { anthropicForcedChoiceSuppressesThinking } from "./Anthropic_Thinking";

/**
 * Anthropic rejects empty text blocks and empty content arrays on non-final
 * messages, and hand-built or previously recorded checkpoint prefixes may
 * still carry them: drop empty text blocks while converting, and skip any
 * message whose content ends up empty.
 */
function isEmptyTextBlock(block: { type?: unknown; text?: unknown }): boolean {
  return block.type === "text" && (block.text === undefined || block.text === "");
}

/**
 * Whether a stored block is one of the kinds this provider captures, with the
 * fields Anthropic requires of it. An empty text block is refused outright, and
 * one cannot be dropped from a signed turn, so a payload holding one (never
 * emitted here) is rebuilt instead; so is a tool_use without an input object.
 */
function isReplayableBlock(block: unknown): boolean {
  if (block === null || typeof block !== "object" || Array.isArray(block)) return false;
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case "text":
      return typeof b.text === "string" && !isEmptyTextBlock(b);
    case "thinking":
      return (
        typeof b.thinking === "string" && typeof b.signature === "string" && b.signature !== ""
      );
    case "redacted_thinking":
      return typeof b.data === "string" && b.data !== "";
    case "tool_use":
      return (
        typeof b.id === "string" &&
        typeof b.name === "string" &&
        b.input !== null &&
        typeof b.input === "object" &&
        !Array.isArray(b.input)
      );
    default:
      return false;
  }
}

/**
 * The turn a model produced, as the blocks the API returned in the order it
 * returned them — or `undefined` when the payload is unusable or the host
 * changed the turn's tool calls (an id, a name or an input) or its text, in
 * which case it is rebuilt from the message.
 */
export function parseOwnTurn(payload: string, content: ChatMessage["content"]): any[] | undefined {
  let blocks: unknown;
  try {
    blocks = JSON.parse(payload);
  } catch {
    return undefined;
  }
  // Every block must be one this provider writes, carrying what Anthropic
  // requires of it; anything else would be a 400 rather than a rebuilt turn.
  if (!Array.isArray(blocks) || !blocks.every(isReplayableBlock)) return undefined;
  // The payload's calls must be the message's calls exactly — id, name and
  // input — or the replay would send a call the host has since changed.
  const sent = blocks.filter((b) => b?.type === "tool_use") as Array<{
    id?: unknown;
    name?: unknown;
    input?: unknown;
  }>;
  const calls = content.filter((b) => b.type === "tool_use");
  if (sent.length !== calls.length) return undefined;
  const same = sent.every(
    (block, i) =>
      block.id === calls[i]!.id &&
      block.name === calls[i]!.name &&
      JSON.stringify(block.input) === JSON.stringify(calls[i]!.input ?? {})
  );
  if (!same) return undefined;
  // And its text must be the message's text: the turn's text arrives as its
  // text blocks run together, so an edited reply rebuilds rather than replays.
  const sentText = blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => (b as { text: string }).text)
    .join("");
  const messageText = content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
  if (sentText !== messageText) return undefined;
  return blocks.length > 0 ? blocks : undefined;
}

/**
 * `nativeTurnProvider` is the key a reasoning block must carry to be replayed;
 * without it every assistant turn is rebuilt from its text and tool calls.
 */
export function buildAnthropicMessages(
  messages: ReadonlyArray<ChatMessage> | undefined,
  prompt: unknown,
  nativeTurnProvider: string | undefined
): any[] {
  if (!messages || messages.length === 0) {
    return [{ role: "user", content: prompt }];
  }
  const out: any[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const blocks = msg.content
        .filter((b) => b.type !== "reasoning")
        .map((b) => {
          if (b.type === "text") return { type: "text", text: b.text };
          if (b.type === "image") {
            return {
              type: "image",
              source: { type: "base64", media_type: b.mimeType, data: b.data },
            };
          }
          return b;
        })
        .filter((b) => !isEmptyTextBlock(b));
      if (blocks.length === 0) continue;
      out.push({ role: "user", content: blocks });
    } else if (msg.role === "assistant") {
      // The model's own turn, replayed exactly as it produced it: a thinking
      // block's signature binds it to the conversation before it, so its text,
      // the tool inputs and the block order are sent unchanged — and only while
      // the calls still match, since a host that renamed one changed the turn.
      const own =
        nativeTurnProvider === undefined
          ? undefined
          : msg.content.find(
              (b): b is Extract<ChatMessage["content"][number], { type: "reasoning" }> =>
                b.type === "reasoning" &&
                b.provider === nativeTurnProvider &&
                b.payload !== undefined
            );
      const replayed = own ? parseOwnTurn(own.payload!, msg.content) : undefined;
      if (replayed) {
        out.push({ role: "assistant", content: replayed });
        continue;
      }
      // Reasoning another provider streamed as text has no Anthropic form (its
      // thinking blocks are signed), and an unknown block is a 400.
      const blocks = msg.content
        .filter((b) => b.type !== "reasoning")
        .map((b) => {
          if (b.type === "text") return { type: "text", text: b.text };
          if (b.type === "tool_use") {
            return { type: "tool_use", id: b.id, name: b.name, input: b.input };
          }
          return b;
        })
        .filter((b) => !isEmptyTextBlock(b));
      if (blocks.length === 0) continue;
      out.push({ role: "assistant", content: blocks });
    } else if (msg.role === "tool") {
      const blocks = msg.content
        .filter(
          (b): b is Extract<ChatMessage["content"][number], { type: "tool_result" }> =>
            b.type === "tool_result"
        )
        .map((b) => {
          const content = b.content
            .map((inner) => {
              if (inner.type === "text") return { type: "text", text: inner.text };
              if (inner.type === "image") {
                return {
                  type: "image",
                  source: { type: "base64", media_type: inner.mimeType, data: inner.data },
                };
              }
              return inner;
            })
            .filter((inner) => !isEmptyTextBlock(inner));
          // A tool that returned nothing still answers its call: `content` is
          // optional on a tool_result, where an empty text block is a 400.
          return {
            type: "tool_result",
            tool_use_id: b.tool_use_id,
            ...(content.length > 0 ? { content } : {}),
            ...(b.is_error ? { is_error: true } : {}),
          };
        });
      if (blocks.length === 0) continue;
      out.push({ role: "user", content: blocks });
    } else if (msg.role === "system") {
      // System prompts are handled separately via params.system; skip here.
      continue;
    }
  }
  return out;
}

/** A content block as the API produced it, accumulated for replay. */
export type NativeBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; raw: string };

const THINKING_BLOCK_TYPES: ReadonlySet<string> = new Set(["thinking", "redacted_thinking"]);

/**
 * The reply's blocks in index order as the API produced them, or `undefined`
 * when there is nothing to replay or the turn cannot be replayed verbatim: a
 * tool input that cannot be parsed from its raw JSON, a thinking block that
 * never received its signature, or an empty text block that must be dropped
 * ahead of a thinking block (the signature binds the blocks before it). The
 * replay must carry exactly what the model wrote, so a guess is worse than
 * rebuilding the turn.
 */
export function serializeNativeTurn(native: ReadonlyMap<number, NativeBlock>): string | undefined {
  const ordered = [...native.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
  let lastThinking = -1;
  ordered.forEach((block, i) => {
    if (THINKING_BLOCK_TYPES.has(block.type)) lastThinking = i;
  });
  const blocks: unknown[] = [];
  for (const [i, block] of ordered.entries()) {
    if (block.type === "tool_use") {
      let input: unknown;
      try {
        input = block.raw ? JSON.parse(block.raw) : {};
      } catch {
        return undefined;
      }
      blocks.push({ type: "tool_use", id: block.id, name: block.name, input });
    } else if (block.type === "text") {
      // The API rejects an empty text block, so one is dropped — which is only
      // faithful when no thinking block follows it.
      if (block.text !== "") blocks.push(block);
      else if (i < lastThinking) return undefined;
    } else if (block.type === "thinking" && block.signature === "") {
      return undefined;
    } else {
      blocks.push(block);
    }
  }
  return blocks.length > 0 ? JSON.stringify(blocks) : undefined;
}

/**
 * The messages with every thinking block removed (a message left empty is
 * dropped), or `undefined` when there was none to remove — a request without
 * thinking cannot have been rejected for it, so there is nothing to retry.
 */
export function withoutThinking(messages: readonly any[]): any[] | undefined {
  const out: any[] = [];
  let removed = false;
  for (const msg of messages) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    const content = msg.content.filter((b: any) => !THINKING_BLOCK_TYPES.has(b?.type));
    if (content.length !== msg.content.length) removed = true;
    if (content.length > 0) out.push({ ...msg, content });
  }
  return removed ? out : undefined;
}

/**
 * Whether the request, with its thinking fields already applied, may carry
 * signed thinking blocks from earlier turns. Blocks are removed only from a
 * request known to run without thinking, where Anthropic answers a replayed
 * block with a 400; when that is uncertain they are sent, since a thinking run
 * needs the block ahead of a pending `tool_use` and loses its reasoning
 * without the rest.
 *
 * - `thinking` present: replay unless its type is `disabled`.
 * - `thinking` absent with `output_config.effort` set: replay — a Claude 5+
 *   model runs adaptive thinking when `thinking` is omitted.
 * - Both absent: strip only when the request is known to run without thinking:
 *   the model's id parses as a generation before 5, where omitting `thinking`
 *   means none, or a forced `tool_choice` suppressed the legacy extended
 *   thinking the model is configured for. An id that does not parse (an alias,
 *   a fine-tune) may be a model that thinks by default, and with no model at
 *   all nothing is known; both replay.
 */
export function requestAllowsThinkingReplay(
  params: Readonly<Record<string, unknown>>,
  model: AnthropicModelConfig | undefined
): boolean {
  const thinking = params.thinking as { type?: unknown } | undefined;
  if (thinking !== undefined) return thinking.type !== "disabled";
  if ((params.output_config as { effort?: unknown } | undefined)?.effort !== undefined) {
    return true;
  }
  if (model === undefined) return true;
  const parsed = parsedModelName(model);
  if (parsed !== undefined && parsed.major < 5) return false;
  return !anthropicForcedChoiceSuppressesThinking(params, model);
}

/**
 * Removes the thinking blocks from `params.messages` when
 * {@link requestAllowsThinkingReplay} says this request may not carry them.
 * Call it once the messages are final — prefix replay included — so every
 * block the request would send is covered.
 */
export function omitThinkingUnlessReplayAllowed(
  params: Record<string, unknown>,
  model: AnthropicModelConfig | undefined
): void {
  if (requestAllowsThinkingReplay(params, model) || !Array.isArray(params.messages)) return;
  const stripped = withoutThinking(params.messages);
  if (stripped !== undefined) params.messages = stripped;
}

/** The leading clause of Anthropic's 400 for a replayed thinking block it will not accept. */
export const THINKING_SIGNATURE_ERROR_TEXT = "Invalid `signature` in `thinking` block";

/**
 * Anthropic's 400 for a replayed thinking block whose signature no longer
 * matches (the history before it changed, or the block was tampered with).
 *
 * The SDK's `APIError` carries the response body's `error.type` on `type` and
 * the body itself on `error`, but that type is `invalid_request_error` for
 * every malformed request, so it only rules other failures out; the message
 * is what names this one. A plain error without a type is judged by its
 * message alone.
 */
export function isThinkingSignatureError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as {
    status?: unknown;
    type?: unknown;
    message?: unknown;
    error?: { type?: unknown; message?: unknown; error?: { type?: unknown; message?: unknown } };
  };
  if (e.status !== 400) return false;
  const body = e.error?.error ?? e.error;
  const type = typeof e.type === "string" ? e.type : body?.type;
  if (typeof type === "string" && type !== "invalid_request_error") return false;
  const message = typeof body?.message === "string" ? body.message : e.message;
  return typeof message === "string" && message.includes(THINKING_SIGNATURE_ERROR_TEXT);
}

/**
 * Sends a request through `send`, and when Anthropic rejects a replayed
 * thinking block before any output reached the consumer, sends it once more
 * with every thinking block removed — the documented recovery. Any other
 * failure, a second rejection, or one after output is rethrown.
 */
export async function sendWithThinkingRetry(
  params: Record<string, unknown>,
  send: (requestParams: Record<string, unknown>) => Promise<void>,
  hasEmitted: () => boolean,
  modelName: string
): Promise<void> {
  try {
    await send(params);
  } catch (err) {
    if (hasEmitted() || !isThinkingSignatureError(err) || !Array.isArray(params.messages)) {
      throw err;
    }
    const stripped = withoutThinking(params.messages);
    if (stripped === undefined) throw err;
    getLogger().warn("Anthropic rejected replayed thinking; retrying without it.", {
      model: modelName,
    });
    await send({ ...params, messages: stripped });
  }
}
