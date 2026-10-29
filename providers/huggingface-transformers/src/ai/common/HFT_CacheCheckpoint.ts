/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TextGenerationPipeline } from "@huggingface/transformers";
import type {
  AiProviderRunFn,
  CacheCheckpointTaskInput,
  CacheCheckpointTaskOutput,
  ChatMessage,
  CheckpointPrefix,
} from "@workglow/ai";
import type { HfTransformersOnnxModelConfig } from "./HFT_ModelSchema";
import type { HftSessionState } from "./HFT_Pipeline";
import {
  getPipeline,
  getPipelineCacheKey,
  loadTransformersSDK,
  snapshotHftSession,
  withHftPipelineInUse,
} from "./HFT_Pipeline";
import { buildHFTMessages, mapHFTTools } from "./HFT_ToolCalling";
import { isHftVisionModel } from "./HFT_VisionLanguage";

/**
 * The `startsWith` anchor for prefix-rewind KV reuse: the exact text the
 * stored snapshot encodes ({@link HftPrefixRewindSession.encodedText}) when
 * present, else the `renderPrefix` fallback re-rendering — so consumers skip
 * the per-call jinja re-render for snapshots that carry their own text.
 */
export function resolveHftParityAnchor(
  session: HftSessionState | undefined,
  renderPrefix: () => string
): string {
  return session?.mode === "prefix-rewind" && session.encodedText !== undefined
    ? session.encodedText
    : renderPrefix();
}

/**
 * Renders a checkpoint prefix with the model's chat template (no generation prompt).
 *
 * The prefix must tokenize identically to the consuming run-fn's prompt: prefix-rewind
 * trusts the cached KV tokens for positions [0:L] without re-checking them, so any
 * divergence corrupts generation. Tools therefore go through the same {@link mapHFTTools}
 * mapping used by HFT_ToolCalling so warm-up and consumption produce the same tokens.
 *
 * No empty user turn is appended for a message-less prefix (the common
 * system-prompt + tools warm-up): consumers append a REAL user turn, so an
 * empty one here would make their continuation diverge right after the system
 * block and defeat the `startsWith` KV-reuse check. A prefix with neither
 * system prompt nor messages (typically tools-only) is rendered from an EMPTY
 * message list, which yields just the template's standing header (tools block /
 * default system preamble) that every real continuation starts with; only
 * templates that reject an empty list fall back to the placeholder user turn —
 * which no real continuation begins with, so those consumers take the full
 * re-encode path.
 */
export function renderHftPrefixPrompt(
  tokenizer: TextGenerationPipeline["tokenizer"],
  prefix: CheckpointPrefix
): string {
  const templateOptions = {
    ...(prefix.tools && prefix.tools.length > 0 ? { tools: mapHFTTools(prefix.tools) as any } : {}),
    tokenize: false,
    add_generation_prompt: false,
  };
  const hasMessages = prefix.messages !== undefined && prefix.messages.length > 0;
  if (!hasMessages && !prefix.systemPrompt) {
    try {
      return tokenizer.apply_chat_template([] as any, templateOptions) as string;
    } catch {
      const placeholder = buildHFTMessages(undefined, undefined, undefined, undefined);
      return tokenizer.apply_chat_template(placeholder as any, templateOptions) as string;
    }
  }
  const messages = hasMessages
    ? buildHFTMessages(prefix.messages, prefix.systemPrompt, undefined, undefined)
    : [{ role: "system", content: prefix.systemPrompt }];
  return tokenizer.apply_chat_template(messages as any, templateOptions) as string;
}

/**
 * Renders the checkpoint prefix followed by one more user turn carrying
 * `prompt`, with the generation prompt appended — the prompt a checkpoint
 * consumer feeds to the model.
 *
 * It mirrors {@link renderHftPrefixPrompt}'s template options exactly (same
 * tools / systemPrompt), only appending the extra user message and
 * `add_generation_prompt: true`. Chat templates render messages sequentially,
 * so for a concatenative template this output begins byte-for-byte with the
 * {@link renderHftPrefixPrompt} rendering — the invariant prefix-rewind KV
 * reuse relies on. Consumers still verify with `startsWith` before trusting
 * cached KV, because some templates rewrite earlier turns.
 *
 * @param systemPrompt - Effective system prompt override (a caller's own
 *   system prompt taking precedence over the prefix's). When it differs from
 *   the prefix's, the rendering no longer starts with the warm-up rendering,
 *   so parity fails and consumers take the full re-encode fallback —
 *   correctness over cache. Omit to render with the prefix's own.
 */
export function renderHftContinuationPrompt(
  tokenizer: TextGenerationPipeline["tokenizer"],
  prefix: CheckpointPrefix,
  prompt: string,
  systemPrompt?: string | undefined
): string {
  const userMessage: ChatMessage = { role: "user", content: [{ type: "text", text: prompt }] };
  const messages = buildHFTMessages(
    [...(prefix.messages ?? []), userMessage],
    systemPrompt ?? prefix.systemPrompt,
    undefined,
    undefined
  );
  return tokenizer.apply_chat_template(messages as any, {
    ...(prefix.tools && prefix.tools.length > 0 ? { tools: mapHFTTools(prefix.tools) as any } : {}),
    tokenize: false,
    add_generation_prompt: true,
  }) as string;
}

export const HFT_CacheCheckpoint: AiProviderRunFn<
  CacheCheckpointTaskInput,
  CacheCheckpointTaskOutput,
  HfTransformersOnnxModelConfig
> = async (_input, model, signal, emit, _outputSchema, sessionContext) => {
  const checkpointId = sessionContext?.sessionId;
  const prefix = sessionContext?.prefix ?? {};
  if (!checkpointId) {
    throw new Error("HFT_CacheCheckpoint: sessionContext.sessionId (checkpoint id) is required.");
  }
  if (isHftVisionModel(model!)) {
    // A vision-language model keeps no KV session (see generateHftVision), so
    // there is nothing to warm. The handle still stands for its prefix — the
    // registry entry carries it, and every consumer renders it in full.
    emit({ type: "finish", data: { checkpoint: checkpointId } });
    return;
  }
  await withHftPipelineInUse(getPipelineCacheKey(model!), async () => {
    const generateText = (await getPipeline(model!, emit, {}, signal)) as TextGenerationPipeline;
    const { DynamicCache } = await loadTransformersSDK();
    const hfModel = generateText.model;
    const hfTokenizer = generateText.tokenizer;

    const prompt = renderHftPrefixPrompt(hfTokenizer, prefix);
    const cache = new DynamicCache();
    const tokenized = hfTokenizer(prompt);
    await hfModel.generate({ ...tokenized, max_new_tokens: 0, past_key_values: cache });

    snapshotHftSession(
      checkpointId,
      cache as Record<string, any>,
      model!.provider_config.model_path,
      getPipelineCacheKey(model!),
      prompt
    );
    emit({ type: "finish", data: { checkpoint: checkpointId } });
  });
};
