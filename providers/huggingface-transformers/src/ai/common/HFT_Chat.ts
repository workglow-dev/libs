/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { asText } from "@workglow/util";
import type {
  AiChatProviderInput,
  AiChatProviderOutput,
  AiProviderRunFn,
  AiSessionContext,
  ChatMessage,
} from "@workglow/ai";
import { renderHftPrefixPrompt } from "./HFT_CacheCheckpoint";
import type { HfTransformersOnnxModelConfig } from "./HFT_ModelSchema";
import {
  deleteHftSession,
  getHftSession,
  getPipeline,
  getPipelineCacheKey,
  hasGpuBufferEntries,
  loadTransformersSDK,
  snapshotHftSession,
  withHftPipelineInUse,
} from "./HFT_Pipeline";
import { hftSamplingOptions } from "./HFT_Sampling";
import type { HftStreamEmit } from "./HFT_Streaming";
import { createStreamingTextStreamer, createTextStreamer } from "./HFT_Streaming";
import { buildHFTMessages, mapHFTTools } from "./HFT_ToolCalling";

export function resolveHftCheckpointSystemPrompt(
  inputSystemPrompt: string | undefined,
  prefixSystemPrompt: string | undefined
): string | undefined {
  return inputSystemPrompt ?? prefixSystemPrompt;
}

/**
 * Execute one chat turn using the HuggingFace Transformers pipeline.
 *
 * Manages prefix-rewind KV-cache sessions: after each successful turn the
 * output `past_key_values` is snapshotted and stored so the next turn
 * can reconstruct a fresh `DynamicCache` that starts from the end of the
 * previous turn rather than re-encoding the full conversation history.
 *
 * @param onDelta - If provided, each decoded token piece is forwarded via
 *   this callback (streaming path). The run path passes `undefined` and
 *   relies on the streamer only for progress reporting.
 *
 * @returns The full text accumulated from the generation.
 */
async function generateTurn(
  input: AiChatProviderInput,
  model: HfTransformersOnnxModelConfig,
  sessionContext: AiSessionContext | undefined,
  emit: HftStreamEmit,
  signal: AbortSignal | undefined,
  onDelta: ((text: string) => void) | undefined
): Promise<string> {
  const generateText = await getPipeline(model, emit, {}, signal);
  const { TextStreamer, InterruptableStoppingCriteria, DynamicCache } = await loadTransformersSDK();

  const sessionId = sessionContext?.sessionId;
  const isCheckpoint = sessionContext?.prefix !== undefined;
  const hfTokenizer = generateText.tokenizer;
  const hfModel = generateText.model;

  const stopping_criteria = new InterruptableStoppingCriteria();
  if (signal) {
    signal.addEventListener("abort", () => stopping_criteria.interrupt(), { once: true });
  }

  // Build message list from the conversation history.
  // `input.messages` already contains the full history including the latest
  // user message when this function is called from AiChatTask.
  //
  // When starting from a cache checkpoint, the prefix's content must be part
  // of the rendered prompt (the chat's own history never contains it), and it
  // must come FIRST so the render can start byte-for-byte with the warm-up
  // rendering — the invariant prefix-rewind KV reuse relies on.
  const prefix = sessionContext?.prefix;
  let messages: Array<Record<string, unknown>>;
  if (isCheckpoint) {
    // buildHFTMessages only falls back to `prompt` when the message list is
    // empty, so append a prompt-only turn explicitly — the combined list is
    // non-empty whenever the prefix carries messages.
    const chatTail: ChatMessage[] =
      input.messages && input.messages.length > 0
        ? [...input.messages]
        : input.prompt !== undefined && input.prompt !== ""
          ? [{ role: "user", content: [{ type: "text", text: asText(input.prompt) }] }]
          : [];
    messages = buildHFTMessages(
      [...(prefix!.messages ?? []), ...chatTail],
      resolveHftCheckpointSystemPrompt(input.systemPrompt, prefix!.systemPrompt),
      undefined,
      undefined
    );
  } else {
    messages = buildHFTMessages(input.messages, input.systemPrompt, input.prompt, undefined);
  }

  const prompt = hfTokenizer.apply_chat_template(messages as any, {
    ...(isCheckpoint && prefix!.tools && prefix!.tools.length > 0
      ? { tools: mapHFTTools(prefix!.tools) as any }
      : {}),
    tokenize: false,
    add_generation_prompt: true,
  }) as string;

  // The checkpoint-prefix rendering is needed only for the turn-1 seed /
  // restore paths (and legacy snapshots without encodedText); render lazily so
  // steady-state turns skip the per-call jinja re-render entirely.
  let renderedPrefix: string | undefined;
  const renderPrefix = (): string =>
    (renderedPrefix ??= renderHftPrefixPrompt(hfTokenizer, prefix!));

  const inputs = hfTokenizer(prompt);
  const promptLen = inputs.input_ids.dims[1];

  // Session cache: prefix-rewind growing with the conversation.
  const modelPath = model.provider_config.model_path;
  const cacheKey = getPipelineCacheKey(model);
  const hftSession = sessionId ? getHftSession(sessionId) : undefined;
  let past_key_values: any = undefined;

  // Attach the session's own previous-turn snapshot whenever the new prompt
  // provably extends the exact text that snapshot encodes — independent of
  // checkpoint-prefix parity, so a chat whose own systemPrompt diverges from
  // the prefix's still reuses its per-turn KV. prefix-rewind trusts cached KV
  // tokens positionally; when no anchor matches, generation falls back to a
  // full re-encode of `prompt` (correct — it carries the entire prefix).
  if (
    hftSession?.mode === "prefix-rewind" &&
    hftSession.modelPath === modelPath &&
    // WebGPU snapshots cannot be shared: the first decode step's update()
    // would dispose the snapshot's gpu-buffer tensors, so skip the attach and
    // re-encode instead.
    !hasGpuBufferEntries(hftSession.baseEntries)
  ) {
    const attachOk =
      hftSession.encodedText !== undefined
        ? prompt.startsWith(hftSession.encodedText)
        : isCheckpoint
          ? prompt.startsWith(renderPrefix())
          : // A plain chat's session has this run-fn as its sole writer;
            // pre-encodedText entries keep the historical unconditional attach.
            true;
    if (attachOk) {
      past_key_values = new DynamicCache(hftSession.baseEntries);
    }
  }

  // Turn-1 seed: the chat's own session does not exist yet, but the warmed
  // checkpoint snapshot sits in this runtime under seedCheckpointId. Read-only
  // reuse — snapshots are stored under the chat's OWN sessionId only, and the
  // seed entry is never deleted or overwritten here.
  const seedCheckpointId = sessionContext?.seedCheckpointId;
  if (past_key_values === undefined && sessionId && !hftSession && seedCheckpointId) {
    const seed = getHftSession(seedCheckpointId);
    if (
      seed?.mode === "prefix-rewind" &&
      seed.modelPath === modelPath &&
      !hasGpuBufferEntries(seed.baseEntries)
    ) {
      const seedAnchor =
        seed.encodedText !== undefined
          ? seed.encodedText
          : isCheckpoint
            ? renderPrefix()
            : undefined;
      if (seedAnchor !== undefined && prompt.startsWith(seedAnchor)) {
        past_key_values = new DynamicCache(seed.baseEntries);
      }
    }
  }

  if (past_key_values === undefined && sessionId && !hftSession && isCheckpoint) {
    // Worker restarted or state evicted (and no seed applied): re-encode the
    // serialized prefix and store the snapshot under the session id.
    if (prompt.startsWith(renderPrefix())) {
      const cache = new DynamicCache();
      const prefixInputs = hfTokenizer(renderPrefix());
      await hfModel.generate({ ...prefixInputs, max_new_tokens: 0, past_key_values: cache });
      const restored = snapshotHftSession(
        sessionId,
        cache as Record<string, any>,
        modelPath,
        cacheKey,
        renderPrefix()
      );
      if (!hasGpuBufferEntries(restored.baseEntries)) {
        past_key_values = new DynamicCache(restored.baseEntries);
      }
    }
  }

  // Snapshot target resolved BEFORE generation so a parity-failed turn can
  // still capture its KV. Checkpoint ids are immutable: snapshot under
  // emitCheckpointId (if any), never overwrite the checkpoint id itself. An
  // ownedSession id is the CALLER's mutable session (a chat seeded from a
  // checkpoint prefix) — keep snapshotting under it so later turns rewind to
  // the previous turn instead of re-encoding the whole growing conversation;
  // a checkpoint must never make a chat slower.
  const immutableCheckpoint = isCheckpoint && !sessionContext?.ownedSession;
  const snapshotTargetId = immutableCheckpoint ? sessionContext?.emitCheckpointId : sessionId;

  if (past_key_values === undefined && snapshotTargetId) {
    // No reusable snapshot (first turn, parity failure, or gpu-buffer guard):
    // attach a fresh empty cache so generate() populates it in place and a
    // snapshot exists for the next turn — without this the chat re-encodes
    // the whole growing conversation every turn.
    past_key_values = new DynamicCache();
  }

  // Accumulator used regardless of streaming mode.
  let accumulated = "";

  let streamer: any;
  if (onDelta) {
    // Streaming path: forward each decoded token piece to the caller's
    // callback and accumulate the full string for KV-cache snapshotting.
    streamer = createStreamingTextStreamer(
      hfTokenizer,
      (text) => {
        accumulated += text;
        onDelta(text);
      },
      TextStreamer,
      emit
    );
  } else {
    // Non-streaming path: use progress-reporting text streamer and accumulate
    // the full text by decoding the output tensor after generation.
    streamer = createTextStreamer(
      hfTokenizer,
      (progress, message) => emit({ type: "phase", message: message ?? "", progress }),
      TextStreamer
    );
  }

  const output = (await hfModel.generate({
    ...inputs,
    max_new_tokens: input.maxTokens ?? 1024,
    // An unset temperature leaves sampling to the model's generation config, so
    // a chat keeps whatever decoding its model ships tuned for.
    ...hftSamplingOptions(input.temperature, "model-default"),
    streamer,
    stopping_criteria: [stopping_criteria],
    ...(past_key_values ? { past_key_values } : {}),
  })) as any;

  // Decode only the newly generated tokens (skip the prompt).
  if (!onDelta) {
    const seqLen = output.dims[1];
    const newTokens = output.slice(0, [promptLen, seqLen], null);
    accumulated = hfTokenizer.decode(newTokens, { skip_special_tokens: true });
  }

  // Snapshot the output KV cache for the next turn, recording the exact text
  // it encodes (this turn's prompt + reply) so the next turn's attach compares
  // against the stored string instead of re-rendering the checkpoint prefix.
  if (snapshotTargetId) {
    let outputCache: any;
    if (past_key_values) {
      // The cache was mutated in-place during generation.
      outputCache = past_key_values;
    } else if (output.past_key_values) {
      outputCache = output.past_key_values;
    }

    if (outputCache) {
      snapshotHftSession(snapshotTargetId, outputCache, modelPath, cacheKey, prompt + accumulated);
    }
  }

  if (
    immutableCheckpoint &&
    sessionContext?.supersedeParent &&
    sessionId &&
    sessionContext?.emitCheckpointId
  ) {
    deleteHftSession(sessionId);
  }

  return accumulated;
}

export const HFT_Chat: AiProviderRunFn<
  AiChatProviderInput,
  AiChatProviderOutput,
  HfTransformersOnnxModelConfig
> = async (input, model, signal, emit, _outputSchema, sessionContext) => {
  // Refcount the pipeline for the duration of a single turn — long-lived
  // conversations are not held across turns; only active inference is
  // protected from concurrent LRU eviction.
  await withHftPipelineInUse(getPipelineCacheKey(model!), async () => {
    await generateTurn(input, model!, sessionContext, emit, signal, (piece) => {
      emit({ type: "text-delta", port: "text", textDelta: piece });
    });
    emit({ type: "finish", data: {} as AiChatProviderOutput });
  });
};
