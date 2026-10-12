/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DataPortSchema } from "@workglow/util/schema";

export type ContentBlockText = {
  readonly type: "text";
  readonly text: string;
};

export type ContentBlockImage = {
  readonly type: "image";
  readonly mimeType: string;
  readonly data: string;
};

export type ContentBlockToolUse = {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  /**
   * Opaque, provider-scoped signature that some models attach to a tool call
   * and require to be echoed back verbatim on the corresponding request part in
   * later turns. Gemini "thinking" models (2.5+/3.x) return a `thoughtSignature`
   * here; replaying it is mandatory or the API rejects the multi-turn request.
   * Providers that have no such concept leave it undefined.
   */
  readonly providerSignature?: string;
};

/**
 * What a thinking model reasoned before the rest of its reply, kept so it can
 * be handed back on later rounds of the same turn. Some providers ask for it
 * back (DeepSeek's `reasoning_content` on an assistant turn that called tools),
 * and a model given its own reasoning continues from it rather than working the
 * plan out again each round. A provider that has no use for it skips the block.
 * `payload` is a provider's whole turn, kept so that provider can resume its own
 * reasoning, which it returns only in its own encoded form.
 */
export type ContentBlockReasoning = {
  readonly type: "reasoning";
  readonly text: string;
  /**
   * The provider whose assistant turn `payload` is, when the round kept it. That
   * provider replays the payload verbatim on later rounds; every other provider
   * reads `text` or skips the block.
   */
  readonly provider?: string;
  /** The provider's own assistant output for this turn, serialized in its wire format and order. */
  readonly payload?: string;
};

/**
 * Blocks that may appear in a `tool_result`'s `content` array. Provider payloads
 * typically use text, image, and tool_use; nested `tool_result` is not modeled
 * here so the JSON schema can be embedded in parent task schemas without a
 * recursive `$ref` (which fails to resolve when `ContentBlockSchema` is nested
 * under a larger document such as `ToolCallingInputSchema`).
 */
export type ContentBlockInToolResultBody =
  | ContentBlockText
  | ContentBlockImage
  | ContentBlockToolUse;

export type ContentBlockToolResult = {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: ReadonlyArray<ContentBlockInToolResultBody>;
  readonly is_error: boolean | undefined;
};

export type ContentBlock =
  | ContentBlockText
  | ContentBlockImage
  | ContentBlockToolUse
  | ContentBlockToolResult
  | ContentBlockReasoning;

export type ChatRole = "user" | "assistant" | "tool" | "system";

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: ReadonlyArray<ContentBlock>;
}

const ContentBlockTextSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["text"] },
    text: { type: "string" },
  },
  required: ["type", "text"],
  additionalProperties: false,
} as const;

const ContentBlockImageSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["image"] },
    mimeType: { type: "string" },
    data: { type: "string" },
  },
  required: ["type", "mimeType", "data"],
  additionalProperties: false,
} as const;

const ContentBlockToolUseSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["tool_use"] },
    id: { type: "string" },
    name: { type: "string" },
    input: { type: "object", additionalProperties: true },
    providerSignature: { type: "string" },
  },
  required: ["type", "id", "name", "input"],
  additionalProperties: false,
} as const;

const ContentBlockReasoningSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["reasoning"] },
    text: { type: "string" },
    provider: { type: "string" },
    payload: { type: "string" },
  },
  required: ["type", "text"],
  additionalProperties: false,
} as const;

/** `tool_result.content` — text, image, and tool_use only (no nested `tool_result`). */
const ContentBlockInToolResultBodySchema = {
  oneOf: [ContentBlockTextSchema, ContentBlockImageSchema, ContentBlockToolUseSchema],
} as const;

const ContentBlockToolResultSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["tool_result"] },
    tool_use_id: { type: "string" },
    content: {
      type: "array",
      items: ContentBlockInToolResultBodySchema,
    },
    is_error: { type: "boolean" },
  },
  required: ["type", "tool_use_id", "content"],
  additionalProperties: false,
} as const;

// Not a DataPortSchema because the root is `oneOf`, not `type: "object"`.
// Consumers embed it inside an object schema (see ChatMessageSchema).
export const ContentBlockSchema = {
  oneOf: [
    ContentBlockTextSchema,
    ContentBlockImageSchema,
    ContentBlockToolUseSchema,
    ContentBlockToolResultSchema,
    ContentBlockReasoningSchema,
  ],
  title: "ContentBlock",
  description: "A single content block within a chat message",
} as const;

export const ChatMessageSchema = {
  type: "object",
  properties: {
    role: { type: "string", enum: ["user", "assistant", "tool", "system"] },
    content: {
      type: "array",
      items: ContentBlockSchema,
    },
  },
  required: ["role", "content"],
  additionalProperties: false,
  title: "ChatMessage",
  description: "A single chat message with role and structured content blocks",
} as const satisfies DataPortSchema;

export function isContentBlockInToolResultBody(
  value: unknown
): value is ContentBlockInToolResultBody {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "text":
      return typeof v.text === "string";
    case "image":
      return typeof v.mimeType === "string" && typeof v.data === "string";
    case "tool_use":
      return (
        typeof v.id === "string" &&
        typeof v.name === "string" &&
        v.input !== null &&
        typeof v.input === "object"
      );
    default:
      return false;
  }
}

export function isContentBlock(value: unknown): value is ContentBlock {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "text":
      return typeof v.text === "string";
    case "image":
      return typeof v.mimeType === "string" && typeof v.data === "string";
    case "tool_use":
      return (
        typeof v.id === "string" &&
        typeof v.name === "string" &&
        v.input !== null &&
        typeof v.input === "object"
      );
    case "tool_result":
      return (
        typeof v.tool_use_id === "string" &&
        Array.isArray(v.content) &&
        v.content.every(isContentBlockInToolResultBody)
      );
    case "reasoning":
      return (
        typeof v.text === "string" &&
        (v.provider === undefined || typeof v.provider === "string") &&
        (v.payload === undefined || typeof v.payload === "string")
      );
    default:
      return false;
  }
}

export function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const validRole =
    v.role === "user" || v.role === "assistant" || v.role === "tool" || v.role === "system";
  return validRole && Array.isArray(v.content) && v.content.every(isContentBlock);
}

export function textMessage(role: ChatRole, text: string): ChatMessage {
  return { role, content: [{ type: "text", text }] };
}
