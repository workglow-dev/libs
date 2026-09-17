/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  ImageGenerateTaskInput,
  ImageGenerateTaskOutput,
  Usage,
} from "@workglow/ai";
import { ImageGenerationContentPolicyError, ImageGenerationProviderError } from "@workglow/ai";
import type { ImageValue } from "@workglow/util/media";

import {
  dataUriToImageValue,
  mapOpenAIImageUsage,
  modelIdForError,
} from "@workglow/ai/provider-utils";
import { getClient, getModelName } from "./OpenAI_Client";
import type { OpenAiModelConfig } from "./OpenAI_ModelSchema";

/** Maps the normalized aspect ratio to gpt-image-2 / DALL-E supported sizes. */
function aspectRatioToSize(
  aspectRatio: string | undefined
): "1024x1024" | "1024x1536" | "1536x1024" {
  switch (aspectRatio) {
    case "16:9":
    case "4:3":
      return "1536x1024";
    case "9:16":
    case "3:4":
      return "1024x1536";
    case "1:1":
    default:
      return "1024x1024";
  }
}

async function decodeB64Png(b64: string): Promise<ImageValue> {
  return dataUriToImageValue(`data:image/png;base64,${b64}`);
}

/**
 * Streaming run-fn for `["image.generation"]`. GPT-image models support
 * native streaming via `stream: true` + `partial_images: 3` and emit a
 * `snapshot` event per partial frame plus a final snapshot. DALL-E models
 * do not support streaming so this falls back to a single non-streaming
 * call and emits one snapshot before finish.
 */
export const OpenAI_ImageGenerate_Stream: AiProviderRunFn<
  ImageGenerateTaskInput,
  ImageGenerateTaskOutput,
  OpenAiModelConfig
> = async (input, model, signal, emit) => {
  const client = await getClient(model);
  const modelName = getModelName(model);
  const size = aspectRatioToSize(input.aspectRatio);

  // DALL-E 2 and DALL-E 3 do not support streaming — fall back to non-streaming.
  if (modelName.startsWith("dall-e")) {
    try {
      const resp = await (
        client.images.generate as unknown as (
          body: Record<string, unknown>,
          options: { signal: AbortSignal }
        ) => Promise<{ data?: Array<{ b64_json?: string }>; usage?: unknown }>
      )(
        {
          model: modelName,
          prompt: input.prompt,
          size,
          quality: input.quality,
          n: 1,
          response_format: "b64_json",
          ...(input.providerOptions ?? {}),
        },
        { signal }
      );
      const b64 = resp.data?.[0]?.b64_json;
      if (!b64) {
        throw new ImageGenerationProviderError(
          modelIdForError(model, "openai"),
          "Empty response (no b64_json)"
        );
      }
      const image = await decodeB64Png(b64);
      emit({ type: "snapshot", data: { image } } as Parameters<typeof emit>[0]);
      // DALL-E reports no usage at all; the mapper returns undefined for a
      // response that omits it, so the finish stays honest rather than zeroed.
      emit({
        type: "finish",
        data: {} as ImageGenerateTaskOutput,
        usage: mapOpenAIImageUsage(resp.usage),
      });
      return;
    } catch (err) {
      if (
        err instanceof ImageGenerationProviderError ||
        err instanceof ImageGenerationContentPolicyError
      ) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : "unknown error";
      if (/safety|policy|moderation/i.test(msg)) {
        throw new ImageGenerationContentPolicyError(modelIdForError(model, "openai"), msg);
      }
      throw new ImageGenerationProviderError(modelIdForError(model, "openai"), msg, {
        cause: err as Error,
      });
    }
  }

  // GPT image models support streaming.
  try {
    const stream = await client.images.generate(
      {
        model: modelName,
        prompt: input.prompt,
        size,
        quality: input.quality as "low" | "medium" | "high" | "auto" | undefined,
        n: 1,
        stream: true,
        partial_images: 3,
        ...(input.providerOptions ?? {}),
      },
      { signal }
    );

    // Billed usage rides the terminal `image_generation.completed` event, which
    // also carries the final image — so it has to be read before the b64 guard
    // below, not after it.
    let usage: Usage | undefined;
    for await (const event of stream) {
      if (signal.aborted) return;
      usage = mapOpenAIImageUsage((event as { usage?: unknown }).usage) ?? usage;
      const b64 = event.b64_json;
      if (!b64) continue;
      const image = await decodeB64Png(b64);
      emit({ type: "snapshot", data: { image } } as Parameters<typeof emit>[0]);
    }
    emit({ type: "finish", data: {} as ImageGenerateTaskOutput, usage });
  } catch (err) {
    if (
      err instanceof ImageGenerationProviderError ||
      err instanceof ImageGenerationContentPolicyError
    ) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : "unknown error";
    if (/safety|policy|moderation/i.test(msg)) {
      throw new ImageGenerationContentPolicyError(modelIdForError(model, "openai"), msg);
    }
    throw new ImageGenerationProviderError(modelIdForError(model, "openai"), msg, {
      cause: err as Error,
    });
  }
};
