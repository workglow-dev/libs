/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, ImageEditTaskInput, ImageEditTaskOutput, Usage } from "@workglow/ai";
import { ImageGenerationContentPolicyError, ImageGenerationProviderError } from "@workglow/ai";
import type { ImageValue } from "@workglow/util/media";

import {
  dataUriToImageValue,
  imageValueToPngBytes,
  mapOpenAIImageUsage,
  modelIdForError,
} from "@workglow/ai/provider-utils";
import { getClient, getModelName } from "./OpenAI_Client";
import type { OpenAiModelConfig } from "./OpenAI_ModelSchema";

type OpenAiImageInput = ImageValue | string;

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

/**
 * Encode an inbound `ImageValue` (or a serialized data URI from the worker
 * boundary) to PNG bytes wrapped in a File suitable for the OpenAI multipart
 * upload. Uses `OpenAI.toFile` when available (SDK v4+), otherwise falls
 * back to `new File(...)`.
 */
async function gpuImageToOpenAiFile(image: OpenAiImageInput, name: string): Promise<unknown> {
  const bytes = await imageValueToPngBytes(image);
  // Copy to a plain ArrayBuffer to avoid SharedArrayBuffer typing issues with BlobPart.
  const buffer: ArrayBuffer =
    bytes.buffer instanceof ArrayBuffer
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : new Uint8Array(bytes).buffer;
  const sdk = (await import("openai")) as unknown as {
    toFile?: (input: unknown, name?: string, options?: { type?: string }) => Promise<unknown>;
  };
  if (typeof sdk.toFile === "function") {
    return sdk.toFile(new Blob([buffer], { type: "image/png" }), name, { type: "image/png" });
  }
  return new File([buffer], name, { type: "image/png" });
}

async function decodeB64Png(b64: string): Promise<ImageValue> {
  return dataUriToImageValue(`data:image/png;base64,${b64}`);
}

async function buildEditPayload(
  input: ImageEditTaskInput,
  model: OpenAiModelConfig | undefined
): Promise<Record<string, unknown>> {
  const modelName = getModelName(model);
  // image/mask/additionalImages may be data URI strings when the input crossed
  // the worker boundary via AiImageOutputTask.getJobInput materialization.
  const primary = await gpuImageToOpenAiFile(
    input.image as unknown as OpenAiImageInput,
    "image.png"
  );
  const additionalFiles =
    input.additionalImages && (input.additionalImages as OpenAiImageInput[]).length > 0
      ? await Promise.all(
          (input.additionalImages as OpenAiImageInput[]).map((g, i) =>
            gpuImageToOpenAiFile(g, `image-${i + 1}.png`)
          )
        )
      : [];
  const imageField = additionalFiles.length === 0 ? primary : [primary, ...additionalFiles];

  const payload: Record<string, unknown> = {
    model: modelName,
    prompt: input.prompt,
    image: imageField,
    size: aspectRatioToSize(input.aspectRatio),
    quality: input.quality,
    n: 1,
    ...(input.providerOptions ?? {}),
  };
  if (input.mask) {
    payload.mask = await gpuImageToOpenAiFile(
      input.mask as unknown as OpenAiImageInput,
      "mask.png"
    );
  }
  return payload;
}

/**
 * Streaming run-fn for `["image.editing"]`. SDK v6.35+ supports
 * `stream: true` on `images.edit` for GPT image models — emits snapshot
 * events for each partial + final image, then finish.
 */
export const OpenAI_ImageEdit_Stream: AiProviderRunFn<
  ImageEditTaskInput,
  ImageEditTaskOutput,
  OpenAiModelConfig
> = async (input, model, signal, emit) => {
  const client = await getClient(model);

  try {
    const payload = await buildEditPayload(input, model);
    const stream = await (
      client.images.edit as unknown as (
        body: Record<string, unknown>,
        options: { signal: AbortSignal }
      ) => Promise<AsyncIterable<{ b64_json?: string; usage?: unknown }>>
    )({ ...payload, stream: true, partial_images: 3 }, { signal });

    // Billed usage rides the terminal `image_edit.completed` event, which also
    // carries the final image — so it has to be read before the b64 guard below,
    // not after it. An edit is where the image half of the prompt is largest:
    // every input image is billed at the image-input rate.
    let usage: Usage | undefined;
    for await (const event of stream) {
      if (signal.aborted) return;
      usage = mapOpenAIImageUsage(event.usage) ?? usage;
      const b64 = event.b64_json;
      if (!b64) continue;
      const image = await decodeB64Png(b64);
      emit({ type: "snapshot", data: { image } } as Parameters<typeof emit>[0]);
    }
    emit({ type: "finish", data: {} as ImageEditTaskOutput, usage });
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
