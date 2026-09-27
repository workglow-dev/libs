/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message, TextGenerationPipeline } from "@huggingface/transformers";
import type {
  AiProviderRunFn,
  TextGenerationTaskInput,
  TextGenerationTaskOutput,
} from "@workglow/ai";
import {
  renderHftContinuationPrompt,
  renderHftPrefixPrompt,
  resolveHftParityAnchor,
} from "./HFT_CacheCheckpoint";
import type { HfTransformersOnnxModelConfig } from "./HFT_ModelSchema";
import type { HftProgressiveSession } from "./HFT_Pipeline";
import {
  deleteHftSession,
  getHftSession,
  getPipeline,
  getPipelineCacheKey,
  hasGpuBufferEntries,
  loadTransformersSDK,
  setHftSession,
  snapshotHftSession,
  withHftPipelineInUse,
} from "./HFT_Pipeline";
import { hftSamplingOptions } from "./HFT_Sampling";
import { createStreamingTextStreamer } from "./HFT_Streaming";

export const HFT_TextGeneration: AiProviderRunFn<
  TextGenerationTaskInput,
  TextGenerationTaskOutput,
  HfTransformersOnnxModelConfig
> = async (input, model, signal, emit, _outputSchema, sessionContext) => {
  const sessionId = sessionContext?.sessionId;
  await withHftPipelineInUse(getPipelineCacheKey(model!), async () => {
    const generateText = (await getPipeline(model!, emit, {}, signal)) as TextGenerationPipeline;
    const { TextStreamer, InterruptableStoppingCriteria } = await loadTransformersSDK();
    // Accumulated only to record the emitted checkpoint's encodedText; the
    // finish event stays empty per the streaming convention.
    let accumulated = "";
    const streamer = createStreamingTextStreamer(
      generateText.tokenizer,
      (text) => {
        accumulated += text;
        emit({ type: "text-delta", port: "text", textDelta: text });
      },
      TextStreamer,
      emit
    );
    const stopping_criteria = new InterruptableStoppingCriteria();
    if (signal) {
      signal.addEventListener("abort", () => stopping_criteria.interrupt(), { once: true });
    }

    const modelPath = model!.provider_config.model_path;
    const cacheKey = getPipelineCacheKey(model!);
    // Greedy unless a temperature is asked for, whatever the model's generation
    // config prefers.
    const sampling = hftSamplingOptions(input.temperature, "greedy");
    const isCheckpoint = sessionContext?.prefix !== undefined;

    // Cache-checkpoint consumption: render the full prefix + input.prompt
    // continuation so the encoded prompt begins with the warm-up prefix
    // rendering, then continue generation from the cached prefix KV. Without
    // this the model would only ever see input.prompt and silently ignore the
    // checkpoint's system prompt / prior messages / tools.
    if (isCheckpoint) {
      const prefix = sessionContext!.prefix!;
      const tokenizer = generateText.tokenizer;
      // The unified ["text.generation"] run-fn also routes messages-less
      // chat-shaped inputs here, so honor a caller systemPrompt when the input
      // carries one; a differing caller prompt breaks warm-up parity below and
      // takes the full re-encode — correctness over cache.
      const inputSystemPrompt = (input as { systemPrompt?: string | undefined }).systemPrompt;
      const prompt = renderHftContinuationPrompt(
        tokenizer,
        prefix,
        input.prompt,
        inputSystemPrompt || prefix.systemPrompt
      );

      // prefix-rewind trusts cached KV tokens positionally, so only attach the
      // prefix cache when the continuation provably starts with the exact text
      // the stored KV encodes — the snapshot's own encodedText when present
      // (no per-call jinja re-render), else the re-rendered warm-up prefix. A
      // non-concatenative template (one that rewrites earlier turns) falls
      // back to a full re-encode of `prompt` — slower, but still correct
      // because `prompt` carries the entire prefix.
      let past_key_values: any = undefined;
      if (sessionId) {
        let session = getHftSession(sessionId);
        const anchor = resolveHftParityAnchor(session, () =>
          renderHftPrefixPrompt(tokenizer, prefix)
        );
        if (prompt.startsWith(anchor)) {
          if (!session) {
            // Missing-state fallback: the checkpoint id has no worker-side KV
            // (worker restarted / evicted). Re-encode the serialized prefix and
            // store the snapshot under the checkpoint id.
            const { DynamicCache } = await loadTransformersSDK();
            const cache = new DynamicCache();
            const tokenized = tokenizer(anchor);
            await generateText.model.generate({
              ...tokenized,
              max_new_tokens: 0,
              past_key_values: cache,
            });
            session = snapshotHftSession(
              sessionId,
              cache as Record<string, any>,
              modelPath,
              cacheKey,
              anchor
            );
          }
          if (
            session?.mode === "prefix-rewind" &&
            session.modelPath === modelPath &&
            // WebGPU snapshots cannot be shared: the first decode step would
            // dispose the snapshot's gpu-buffer tensors (update() replaces
            // them), so skip the attach and re-encode the full prompt instead.
            !hasGpuBufferEntries(session.baseEntries)
          ) {
            const { DynamicCache } = await loadTransformersSDK();
            past_key_values = new DynamicCache(session.baseEntries);
          }
        }
      }

      if (sessionContext?.emitCheckpointId && !past_key_values) {
        // Parity fell back to a full re-encode: attach an empty cache so this
        // turn's KV can still be snapshotted under the emitted checkpoint id.
        const { DynamicCache } = await loadTransformersSDK();
        past_key_values = new DynamicCache();
      }

      await generateText(prompt, {
        streamer,
        ...sampling,
        max_new_tokens: input.maxTokens ?? 4 * 1024,
        stopping_criteria: [stopping_criteria],
        return_full_text: false,
        ...(past_key_values ? { past_key_values } : {}),
      });

      // Checkpoints are immutable: snapshot post-turn state under
      // emitCheckpointId only, never overwrite the consumed checkpoint id.
      if (sessionContext?.emitCheckpointId && past_key_values) {
        snapshotHftSession(
          sessionContext.emitCheckpointId,
          past_key_values,
          modelPath,
          cacheKey,
          prompt + accumulated
        );
        if (sessionContext.supersedeParent && sessionId) {
          deleteHftSession(sessionId);
        }
      }

      emit({ type: "finish", data: {} as TextGenerationTaskOutput });
      return;
    }

    // Session cache: progressive caching for text generation (streaming)
    let session = sessionId ? getHftSession(sessionId) : undefined;
    let past_key_values: any = undefined;

    if (sessionId && !session) {
      const sdk = await loadTransformersSDK();
      const cache = new sdk.DynamicCache();
      const newSession: HftProgressiveSession = {
        mode: "progressive",
        cache,
        modelPath,
        cacheKey,
      };
      setHftSession(sessionId, newSession);
      session = newSession;
    }

    if (session?.mode === "progressive") {
      past_key_values = session.cache;
    }

    if (sessionContext?.emitCheckpointId && !past_key_values) {
      // Emit without a consumed checkpoint: attach an empty cache so this
      // turn's KV can be snapshotted under the emitted checkpoint id.
      const sdk = await loadTransformersSDK();
      past_key_values = new sdk.DynamicCache();
    }

    // Use the chat-template format for instruction-tuned models. Passing a raw
    // prompt string skips the chat template and most instruct models produce no
    // output.
    const messages: Message[] = [{ role: "user", content: input.prompt }];

    await generateText(messages, {
      streamer,
      ...sampling,
      max_new_tokens: input.maxTokens ?? 4 * 1024,
      stopping_criteria: [stopping_criteria],
      ...(past_key_values ? { past_key_values } : {}),
    });

    if (sessionContext?.emitCheckpointId && past_key_values) {
      // The pipeline rendered the chat template internally, so the exact text
      // this KV encodes is not knowable here — store no encodedText and let
      // consumers fall back to re-rendering the checkpoint prefix.
      snapshotHftSession(sessionContext.emitCheckpointId, past_key_values, modelPath, cacheKey);
    }

    // No `usage`: transformers.js runs the model in-process and reports no
    // token accounting of its own. Absent is the honest answer — counting our
    // own emitted tokens would be a local estimate dressed up as a provider fact.
    emit({ type: "finish", data: {} as TextGenerationTaskOutput });
  });
};
