/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { asText } from "@workglow/util";
import type {
  AiProviderRunFn,
  CacheCheckpointTaskInput,
  CacheCheckpointTaskOutput,
  ChatMessage,
  CheckpointPrefix,
  ToolDefinition,
} from "@workglow/ai";
import { toUsageCount } from "@workglow/ai/provider-utils";
import { buildToolDescription, promptToTailMessages } from "@workglow/ai/worker";
import { getLogger } from "@workglow/util/worker";
import { setGeminiCachedContent } from "./Gemini_CacheStore";
import { createGeminiClient, getModelName } from "./Gemini_Client";
import type { GeminiModelConfig } from "./Gemini_ModelSchema";
import { sanitizeSchemaForGemini } from "./Gemini_Schema";
import { buildGeminiContents } from "./Gemini_ToolCalling";
import type { IGeminiContentsOptions } from "./Gemini_ToolCalling";

/** Default TTL for explicit cached content — Gemini bills storage per token-hour. */
const GEMINI_CACHE_TTL = "3600s";

/** Shared Gemini functionDeclarations mapping for tool definitions. */
export function buildGeminiFunctionDeclarations(
  tools: readonly ToolDefinition[]
): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.name,
    description: buildToolDescription(t),
    parameters: sanitizeSchemaForGemini(t.inputSchema as Record<string, unknown>) as any,
  }));
}

/**
 * Canonical string form of the function declarations Gemini receives for a
 * tool list — declaration order and JSON object-key order are normalized away.
 * The warm-up computes this once per cache creation and stores it on the entry
 * ({@link setGeminiCachedContent}) so consumers only canonicalize their own
 * input side per request.
 */
export function canonicalGeminiToolsKey(tools: readonly ToolDefinition[]): string {
  return JSON.stringify(
    buildGeminiFunctionDeclarations(tools).map(normalizeGeminiWireDeclaration).sort()
  );
}

/**
 * Compares the function declarations Gemini receives, ignoring declaration
 * order and JSON object-key order.
 */
export function geminiCachedToolsMatch(
  prefixTools: readonly ToolDefinition[],
  inputTools: readonly ToolDefinition[]
): boolean {
  return canonicalGeminiToolsKey(prefixTools) === canonicalGeminiToolsKey(inputTools);
}

/**
 * {@link geminiCachedToolsMatch} against a prefix side already canonicalized at
 * cache creation — only the input side pays the recursive canonicalization.
 */
export function geminiCachedToolsMatchCanonical(
  canonicalPrefixTools: string,
  inputTools: readonly ToolDefinition[]
): boolean {
  return canonicalPrefixTools === canonicalGeminiToolsKey(inputTools);
}

function normalizeGeminiWireDeclaration(declaration: Record<string, unknown>): string {
  return JSON.stringify(normalizeGeminiWireValue(declaration));
}

function normalizeGeminiWireValue(value: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const nested = value[key];
    if (nested === undefined) continue;
    sorted[key] =
      key === "parameters" ? normalizeSchemaValue(nested) : normalizeLiteralValue(nested);
  }
  return sorted;
}

function normalizeSchemaValue(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return normalizeLiteralValue(value);
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested === undefined) continue;
    sorted[key] = normalizeSchemaKeyword(key, nested);
  }
  return sorted;
}

function normalizeSchemaKeyword(key: string, value: unknown): unknown {
  switch (key) {
    case "allOf":
    case "anyOf":
    case "oneOf":
      return normalizeSchemaArray(value, true);
    case "enum":
      return normalizeLiteralArray(value, true);
    case "required":
    case "type":
      return normalizeLiteralArray(value, true);
    case "prefixItems":
      return normalizeSchemaArray(value, false);
    case "items":
      return Array.isArray(value)
        ? normalizeSchemaArray(value, false)
        : normalizeSchemaValue(value);
    case "$defs":
    case "definitions":
    case "dependentSchemas":
    case "patternProperties":
    case "properties":
      return normalizeSchemaMap(value);
    case "dependencies":
      return normalizeDependencies(value);
    case "dependentRequired":
      return normalizeRequiredMap(value);
    case "additionalItems":
    case "additionalProperties":
    case "contains":
    case "contentSchema":
    case "else":
    case "if":
    case "not":
    case "propertyNames":
    case "then":
    case "unevaluatedItems":
    case "unevaluatedProperties":
      return normalizeSchemaValue(value);
    default:
      return normalizeLiteralValue(value);
  }
}

function normalizeSchemaArray(value: unknown, unordered: boolean): unknown {
  if (!Array.isArray(value)) return normalizeLiteralValue(value);
  const normalized = value.map(normalizeSchemaValue);
  return unordered ? sortCanonicalValues(normalized) : normalized;
}

function normalizeLiteralArray(value: unknown, unordered: boolean): unknown {
  if (!Array.isArray(value)) return normalizeLiteralValue(value);
  const normalized = value.map(normalizeLiteralValue);
  return unordered ? sortCanonicalValues(normalized) : normalized;
}

function normalizeSchemaMap(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return normalizeLiteralValue(value);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== undefined) sorted[key] = normalizeSchemaValue(nested);
  }
  return sorted;
}

function normalizeRequiredMap(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return normalizeLiteralValue(value);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== undefined) sorted[key] = normalizeLiteralArray(nested, true);
  }
  return sorted;
}

function normalizeDependencies(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return normalizeLiteralValue(value);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested === undefined) continue;
    sorted[key] = Array.isArray(nested)
      ? normalizeLiteralArray(nested, true)
      : normalizeSchemaValue(nested);
  }
  return sorted;
}

function normalizeLiteralValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeLiteralValue);
  if (value === null || typeof value !== "object") return value;

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== undefined) sorted[key] = normalizeLiteralValue(nested);
  }
  return sorted;
}

function sortCanonicalValues(values: unknown[]): unknown[] {
  return values.sort((left, right) => {
    const leftKey = canonicalSortKey(left);
    const rightKey = canonicalSortKey(right);
    if (leftKey === rightKey) return 0;
    return leftKey < rightKey ? -1 : 1;
  });
}

function canonicalSortKey(value: unknown): string {
  return JSON.stringify(value) ?? `${typeof value}:${String(value)}`;
}

/**
 * Builds the `contents` for a checkpoint consumer replaying the prefix inline:
 * prefix messages first, then the caller's tail (its `messages`, or its
 * `prompt` lifted into a user turn — {@link buildGeminiContents} only falls
 * back to `prompt` when the message list is empty).
 */
export function buildGeminiPrefixedContents(
  prefix: CheckpointPrefix,
  messages: ReadonlyArray<ChatMessage> | undefined,
  prompt: unknown,
  options: IGeminiContentsOptions = {}
): any[] {
  const tail: ChatMessage[] =
    messages && messages.length > 0 ? [...messages] : promptToTailMessages(prompt);
  return buildGeminiContents([...(prefix.messages ?? []), ...tail], "", options);
}

/**
 * Warm-up run-fn for `["cache.checkpoint"]` on Gemini. Creates an explicit
 * server-side CachedContent from the prefix (system prompt + tools + messages)
 * and records its resource name under the checkpoint id, so consumers can
 * reference it and send only their tail.
 *
 * Creation is advisory: explicit caching has a per-model minimum prefix size,
 * so a too-small (or unsupported) prefix degrades to no entry — consumers then
 * replay the registry prefix inline, where Gemini's implicit caching still
 * applies. The consumed cache also expires by TTL, which the inline-replay
 * fallback covers as well.
 */
/**
 * Bucket a cache-creation (or subsequent) error into one of three fates:
 *  - `"abort"` — the caller cancelled (via the AbortSignal or a bubbled-up
 *    AbortError); the run-fn must rethrow so the abort surfaces to the run.
 *  - `"degrade"` — the model rejected the prefix as too small / unsupported for
 *    explicit caching (`400 INVALID_ARGUMENT` with a matching message); the
 *    warm-up degrades to no entry and the consumer replays inline.
 *  - `"throw"` — every other class (auth, quota, transport, server 5xx) is a
 *    real failure; the run-fn rethrows so the caller sees it and can retry.
 */
function classifyGeminiCacheError(
  err: unknown,
  signal: AbortSignal | undefined
): "abort" | "degrade" | "throw" {
  const anyErr = err as { name?: unknown; message?: unknown; status?: unknown; code?: unknown };
  const message = asText(anyErr?.message ?? err);
  const name = asText(anyErr?.name);
  if (
    signal?.aborted ||
    (typeof DOMException !== "undefined" &&
      err instanceof DOMException &&
      err.name === "AbortError") ||
    name === "AbortError" ||
    /aborted|AbortError/i.test(message)
  ) {
    return "abort";
  }
  const status = anyErr?.status;
  const code = anyErr?.code;
  // The live API rejects an undersized prefix with "Cached content is too
  // small. total_token_count=…, min_total_token_count=…" — and the SDK may
  // deliver that JSON-wrapped inside ApiError.message — so match that wording
  // (and the min_total_token field name), not just "prefix … too … small".
  const looksLikePrefixTooSmall =
    /too.?small|min_total_token|cached.*content.*not.*supported|minimum.*token/i.test(message);
  if ((status === 400 || code === "INVALID_ARGUMENT") && looksLikePrefixTooSmall) {
    return "degrade";
  }
  return "throw";
}

export const Gemini_CacheCheckpoint_Stream: AiProviderRunFn<
  CacheCheckpointTaskInput,
  CacheCheckpointTaskOutput,
  GeminiModelConfig
> = async (_input, model, signal, emit, _outputSchema, session) => {
  const checkpointId = session?.sessionId;
  if (!checkpointId) {
    throw new Error(
      "Gemini_CacheCheckpoint: sessionContext.sessionId (checkpoint id) is required."
    );
  }
  const prefix = session?.prefix ?? {};
  const ai = await createGeminiClient(model);

  const contents =
    prefix.messages && prefix.messages.length > 0
      ? buildGeminiContents(prefix.messages, "")
      : [{ role: "user", parts: [{ text: "." }] }];

  // Track the created resource name across the try / catch so a downstream
  // failure (e.g. a bookkeeping throw from `setGeminiCachedContent`) can still
  // cleanup the server-side entry it just minted.
  let createdName: string | undefined;
  let cachedTokens: number | undefined;
  try {
    signal?.throwIfAborted?.();
    const cached = await ai.caches.create({
      model: getModelName(model),
      config: {
        contents,
        ...(prefix.systemPrompt ? { systemInstruction: prefix.systemPrompt } : {}),
        ...(prefix.tools && prefix.tools.length > 0
          ? { tools: [{ functionDeclarations: buildGeminiFunctionDeclarations(prefix.tools) }] }
          : {}),
        ttl: GEMINI_CACHE_TTL,
      },
    } as Parameters<typeof ai.caches.create>[0]);
    cachedTokens = toUsageCount(
      (cached as { usageMetadata?: { totalTokenCount?: unknown } } | undefined)?.usageMetadata
        ?.totalTokenCount
    );
    createdName = cached?.name ?? undefined;
    if (cached?.name) {
      setGeminiCachedContent(checkpointId, {
        name: cached.name,
        model: model!,
        tokens: cachedTokens,
        systemPrompt: prefix.systemPrompt,
        canonicalTools:
          prefix.tools && prefix.tools.length > 0
            ? canonicalGeminiToolsKey(prefix.tools)
            : undefined,
      });
    }
  } catch (err) {
    const fate = classifyGeminiCacheError(err, signal);
    if (fate === "abort" || fate === "throw") {
      if (createdName) {
        await ai.caches
          .delete({ name: createdName } as Parameters<typeof ai.caches.delete>[0])
          .catch(() => {});
      }
      throw err;
    }
    getLogger().warn(
      `Gemini cache checkpoint warm-up degraded to inline replay: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  const usage =
    cachedTokens === undefined
      ? undefined
      : {
          input: undefined,
          output: undefined,
          cached: undefined,
          cacheWrite: cachedTokens,
          reasoning: undefined,
          total: undefined,
          extra: undefined,
        };
  emit({
    type: "finish",
    data: { checkpoint: checkpointId },
    ...(usage ? { usage } : {}),
  });
};
