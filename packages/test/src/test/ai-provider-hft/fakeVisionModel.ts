/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from "vitest";
import type { loadTransformersSDK } from "../../../../../providers/huggingface-transformers/src/ai/common/HFT_Pipeline";

type TransformersSDK = Awaited<ReturnType<typeof loadTransformersSDK>>;

/** What a fake `RawImage.fromBlob` returns: the bytes it was handed, as base64. */
export interface FakeRawImage {
  readonly base64: string;
  readonly mimeType: string;
}

/** One call into the processor, as it was made. */
export interface ProcessorCall {
  readonly args: ReadonlyArray<unknown>;
  /** The rendered prompt, whichever position it was passed in. */
  readonly prompt: string;
  /** The images, in the order the processor received them. */
  readonly images: ReadonlyArray<FakeRawImage>;
  /** Index into {@link FakeVisionModel.rendered} of the render this call encoded. */
  readonly render: number;
}

export interface FakeVisionModel {
  /** The cache entry `getPipeline` would have built. */
  readonly vlm: unknown;
  /** Every message list handed to `apply_chat_template`, with its options. */
  readonly rendered: Array<{ messages: unknown; options: Record<string, unknown> }>;
  /** Every call into the processor (a turn holding images). */
  readonly processorCalls: ProcessorCall[];
  /** Every call into the tokenizer alone (a turn holding none). */
  readonly tokenizerCalls: Array<{ text: string; options: unknown }>;
  /** Every `model.generate` argument, the streamer included. */
  readonly generated: Array<Record<string, unknown>>;
  /** Queue the pieces the next `generate` decodes. */
  readonly reply: (pieces: ReadonlyArray<string>) => void;
  readonly dispose: ReturnType<typeof vi.fn>;
}

/**
 * A stand-in chat template: each turn as `<role>…</role>`, a text part as its
 * text, an image part as `<image>` — the placeholder a real template turns into
 * the model's image token — and an open assistant turn when asked for.
 */
export function renderFakeTemplate(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  addGenerationPrompt: boolean
): string {
  let out = "";
  for (const message of messages) {
    const parts = Array.isArray(message.content)
      ? (message.content as Array<{ type: string; text?: string }>)
          .map((part) => (part.type === "image" ? "<image>" : (part.text ?? "")))
          .join("")
      : String(message.content);
    out += `<${message.role}>${parts}</${message.role}>\n`;
  }
  return addGenerationPrompt ? `${out}<assistant>` : out;
}

/**
 * A vision-language model whose processor records what it is handed and whose
 * model decodes scripted pieces through the real streamer the run-fn built:
 * the prompt first (so prefill and usage are reported), then each piece.
 *
 * `processorClass` gives the processor that class's prototype, for the run-fn's
 * check of which argument a processor takes first.
 */
export function fakeVisionModel(processorClass?: { prototype: object }): FakeVisionModel {
  const rendered: FakeVisionModel["rendered"] = [];
  const processorCalls: ProcessorCall[] = [];
  const tokenizerCalls: FakeVisionModel["tokenizerCalls"] = [];
  const generated: FakeVisionModel["generated"] = [];
  const replies: Array<ReadonlyArray<string>> = [];

  const tokenizer = Object.assign(
    (text: string, options?: unknown) => {
      tokenizerCalls.push({ text, options });
      return { input_ids: { dims: [1, text.length] } };
    },
    { all_special_ids: [] as number[], decode: () => "" }
  );

  const processor = async (...args: unknown[]) => {
    const imagesFirst = Array.isArray(args[0]);
    const prompt = (imagesFirst ? args[1] : args[0]) as string;
    const images = (imagesFirst ? args[0] : args[1]) as FakeRawImage[];
    processorCalls.push({ args, prompt, images, render: rendered.length - 1 });
    return { input_ids: { dims: [1, prompt.length] }, pixel_values: { dims: [images.length] } };
  };
  if (processorClass) Object.setPrototypeOf(processor, processorClass.prototype);
  // Defined rather than assigned: a real processor's `tokenizer` is a getter
  // on its prototype, which an assignment would throw against.
  Object.defineProperty(processor, "tokenizer", { value: tokenizer });
  Object.defineProperty(processor, "apply_chat_template", {
    value: (
      messages: Array<{ role: string; content: unknown }>,
      options: Record<string, unknown>
    ) => {
      rendered.push({ messages: JSON.parse(JSON.stringify(messages)), options });
      return renderFakeTemplate(messages, options.add_generation_prompt === true);
    },
  });

  const dispose = vi.fn(async () => {});
  const model = {
    dispose,
    generate: async (args: Record<string, any>) => {
      generated.push(args);
      const pieces = replies.shift() ?? [];
      const streamer = args.streamer;
      streamer?.put([[1n, 2n, 3n]]);
      for (const piece of pieces) {
        streamer?.token_callback_function?.([7n]);
        streamer?.callback_function?.(piece);
      }
      streamer?.end();
      return { dims: [1, 3 + pieces.length] };
    },
  };

  return {
    vlm: { task: "image-text-to-text", processor, tokenizer, model },
    rendered,
    processorCalls,
    tokenizerCalls,
    generated,
    reply: (pieces) => void replies.push(pieces),
    dispose,
  };
}

/**
 * Replace `RawImage.fromBlob` with one that keeps the bytes it was handed, so a
 * test can say which image reached the processor. Returns the restore.
 */
export function spyOnRawImageDecode(sdk: TransformersSDK): () => void {
  const spy = vi.spyOn(sdk.RawImage, "fromBlob").mockImplementation(
    async (blob: Blob) =>
      ({
        base64: Buffer.from(await blob.arrayBuffer()).toString("base64"),
        mimeType: blob.type,
      }) as never
  );
  return () => spy.mockRestore();
}
