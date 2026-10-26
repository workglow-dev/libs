/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RawImage } from "@huggingface/transformers";
import type { ChatMessage, ContentBlockImage } from "@workglow/ai";
import { asText, base64ToBytes } from "@workglow/util";
import type { HfTransformersOnnxModelConfig } from "./HFT_ModelSchema";
import type { HftVisionLanguageModel } from "./HFT_Pipeline";
import { loadTransformersSDK } from "./HFT_Pipeline";
import type { HftSamplingOptions } from "./HFT_Sampling";
import type { HftStreamEmit } from "./HFT_Streaming";
import { createStreamingTextStreamer } from "./HFT_Streaming";

/**
 * Whether `model` is loaded as a vision-language model (processor +
 * `AutoModelForImageTextToText`) rather than through a `pipeline()`.
 */
export function isHftVisionModel(model: HfTransformersOnnxModelConfig): boolean {
  return model.provider_config.pipeline === "image-text-to-text";
}

/**
 * Refuse a run-fn that has no vision-language path. Such a model infers only
 * the capabilities its run-fns serve, so this is reached only through
 * capabilities declared by hand — and then names the cause, rather than failing
 * on a pipeline call the loaded model does not have.
 */
export function refuseHftVisionModel(model: HfTransformersOnnxModelConfig, runFn: string): void {
  if (!isHftVisionModel(model)) return;
  throw new Error(
    `${runFn}: "${model.provider_config.model_path}" is loaded as an image-text-to-text model, ` +
      `which serves chat, text generation and tool calling only.`
  );
}

/** A content part as vision-language chat templates read it. */
type HftVisionPart = { readonly type: "text"; readonly text: string } | { readonly type: "image" };

/** A conversation rendered for a vision-language chat template, with its images. */
export interface HftVisionConversation {
  readonly messages: Array<Record<string, unknown>>;
  /** The images, in the order their `{ type: "image" }` placeholders appear in `messages`. */
  readonly images: ReadonlyArray<ContentBlockImage>;
}

/** Opens the user turn that carries the images a run of tool results returned. */
export const HFT_TOOL_IMAGES_INTRO = "Images returned by the tool calls above:";

const REQUIRED_TOOL_INSTRUCTION = "You MUST call one of the provided tools in this turn.";

function textPart(text: string): HftVisionPart {
  return { type: "text", text };
}

/** A task `prompt` (string, or text and image blocks) as one user message; none when empty. */
export function promptAsUserMessage(prompt: unknown): ChatMessage | undefined {
  if (prompt === undefined || prompt === null || prompt === "") return undefined;
  if (typeof prompt === "string")
    return { role: "user", content: [{ type: "text", text: prompt }] };
  if (!Array.isArray(prompt))
    return { role: "user", content: [{ type: "text", text: asText(prompt) }] };
  const content: ChatMessage["content"][number][] = [];
  for (const item of prompt) {
    if (typeof item === "string") {
      content.push({ type: "text", text: item });
    } else if (item && typeof item === "object") {
      const block = item as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") {
        content.push({ type: "text", text: block.text });
      } else if (
        block.type === "image" &&
        typeof block.mimeType === "string" &&
        typeof block.data === "string"
      ) {
        content.push({ type: "image", mimeType: block.mimeType, data: block.data });
      }
    }
  }
  return { role: "user", content };
}

/**
 * Build the messages a vision-language model's chat template renders, and the
 * images it is handed beside them.
 *
 * Every message's `content` is a list of parts, never a bare string: the
 * templates that read images iterate it (SmolVLM's indexes `content[0].type`
 * and renders nothing for a string). An image in a user message stays where it
 * was, as an `{ type: "image" }` placeholder the template turns into its own
 * image token; the processor expands each token, in order, into the image's
 * features, so {@link HftVisionConversation.images} is collected in exactly
 * the order the placeholders are emitted.
 *
 * An image a tool returned goes in a user turn after the run of tool results
 * it came from, the result saying `[image N] follows in the next message` and
 * the user turn labelling it `[image N]` — the rule `toOpenAIMessages` follows
 * with `toolImagesInUserMessage`. Some templates would render an image part in
 * a `tool` message (Qwen3-VL, LFM2-VL); others render a `tool` turn as plain
 * text or refuse the role. A template that drops a placeholder leaves the
 * processor one image short of the tokens it expands, which fails the whole
 * generation, so images go in the one role every vision template renders them
 * in, and one rule holds whatever template a model ships.
 *
 * A tool call is written in the `{ type: "function", function: { name,
 * arguments } }` form: LFM2-VL's template reads only that, and Qwen-style
 * templates unwrap it. An assistant turn's reasoning rides as
 * `reasoning_content`, as on the text-model path.
 */
export function buildHftVisionMessages(
  messages: ReadonlyArray<ChatMessage> | undefined,
  systemPrompt: string | undefined,
  prompt: unknown,
  toolChoice: string | undefined
): HftVisionConversation {
  const out: Array<Record<string, unknown>> = [];
  const images: ContentBlockImage[] = [];

  // One system message: several templates read only the first message as the
  // system turn, and Gemma's refuses any other out-of-place role.
  const system = [systemPrompt, toolChoice === "required" ? REQUIRED_TOOL_INSTRUCTION : undefined]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n\n");
  if (system) out.push({ role: "system", content: [textPart(system)] });

  const fromPrompt = promptAsUserMessage(prompt);
  const history: ReadonlyArray<ChatMessage> =
    messages && messages.length > 0 ? messages : fromPrompt ? [fromPrompt] : [];

  // Images a tool returned wait until every result of the run of tool messages
  // is out: a user turn between two results of one assistant turn would leave a
  // call unanswered before it.
  let deferredParts: HftVisionPart[] = [];
  let deferredImages: ContentBlockImage[] = [];
  const flushToolImages = (): void => {
    if (deferredImages.length === 0) return;
    out.push({ role: "user", content: [textPart(HFT_TOOL_IMAGES_INTRO), ...deferredParts] });
    images.push(...deferredImages);
    deferredParts = [];
    deferredImages = [];
  };

  // A tool_result names only the call it answers, so the tool's name is
  // resolved from the tool_use that raised it (most recent id wins).
  const toolNames = new Map<string, string>();
  for (const msg of history) {
    if (msg.role !== "tool") flushToolImages();
    if (msg.role === "user") {
      const parts: HftVisionPart[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push(textPart(block.text));
        } else if (block.type === "image") {
          parts.push({ type: "image" });
          images.push(block);
        }
      }
      out.push({ role: "user", content: parts });
    } else if (msg.role === "assistant") {
      let text = "";
      let reasoning = "";
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          text += block.text;
        } else if (block.type === "reasoning") {
          reasoning += block.text;
        } else if (block.type === "tool_use") {
          toolNames.set(block.id, block.name);
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: block.input },
          });
        }
      }
      const entry: Record<string, unknown> = {
        role: "assistant",
        content: text.length > 0 ? [textPart(text)] : [],
      };
      if (reasoning.length > 0) entry.reasoning_content = reasoning;
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      out.push(entry);
    } else if (msg.role === "tool") {
      for (const block of msg.content) {
        if (block.type !== "tool_result") continue;
        const lines: string[] = [];
        for (const inner of block.content) {
          if (inner.type === "text") {
            lines.push(inner.text);
          } else if (inner.type === "image") {
            const label = `[image ${deferredImages.length + 1}]`;
            lines.push(`${label} follows in the next message`);
            // On its own line: most templates join a message's parts with nothing between.
            deferredParts.push(textPart(`\n${label}\n`), { type: "image" });
            deferredImages.push(inner);
          } else {
            // Data the tool returned (a nested tool_use), kept rather than dropped.
            lines.push(JSON.stringify(inner));
          }
        }
        const name = toolNames.get(block.tool_use_id);
        out.push({
          role: "tool",
          content: [textPart(lines.join("\n"))],
          tool_call_id: block.tool_use_id,
          ...(name !== undefined ? { name } : {}),
        });
      }
    }
  }
  flushToolImages();
  return { messages: out, images };
}

/** Render a conversation with the model's chat template, ready for generation. */
export function renderHftVisionPrompt(
  vlm: HftVisionLanguageModel,
  messages: ReadonlyArray<Record<string, unknown>>,
  tools: ReadonlyArray<unknown> | undefined
): string {
  return vlm.processor.apply_chat_template(messages as any, {
    ...(tools && tools.length > 0 ? { tools: tools as any } : {}),
    tokenize: false,
    add_generation_prompt: true,
  }) as string;
}

type TransformersSDKModule = Awaited<ReturnType<typeof loadTransformersSDK>>;

/**
 * Decode an image block into the `RawImage` a processor reads. A `data:` URL
 * prefix is tolerated, since a caller that built the block from one sometimes
 * leaves it on.
 */
export async function decodeHftImage(
  sdk: Pick<TransformersSDKModule, "RawImage">,
  image: ContentBlockImage
): Promise<RawImage> {
  const bytes = base64ToBytes(image.data.replace(/^data:[^,]*,/, ""));
  return sdk.RawImage.fromBlob(new Blob([bytes as BlobPart], { type: image.mimeType }));
}

/**
 * Processors whose call takes the images first and the text second. The rest
 * (Idefics3/SmolVLM, the Qwen-VL family, Gemma 3, Phi-3 Vision) take the text
 * first. Matched by class rather than by reading the call's parameter names,
 * which a minified build does not keep.
 */
const IMAGES_FIRST_PROCESSORS = [
  "Lfm2VlProcessor",
  "LlavaProcessor",
  "PaliGemmaProcessor",
  "PixtralProcessor",
  "Florence2Processor",
] as const;

export function processorTakesImagesFirst(sdk: object, processor: object): boolean {
  return IMAGES_FIRST_PROCESSORS.some((name) => {
    const cls = (sdk as Record<string, unknown>)[name];
    return typeof cls === "function" && processor instanceof cls;
  });
}

/**
 * Model inputs for a rendered prompt and its images. The template already
 * wrote the special tokens, so the tokenizer is told not to add them again
 * (processors that forward options to their tokenizer honour it). A turn with
 * no image goes through the tokenizer alone: several processors cannot be
 * called without one, and for text they tokenize exactly as the tokenizer does.
 */
export async function encodeHftVisionInputs(
  vlm: HftVisionLanguageModel,
  prompt: string,
  images: ReadonlyArray<ContentBlockImage>
): Promise<Record<string, unknown>> {
  if (images.length === 0) {
    return vlm.tokenizer(prompt, { add_special_tokens: false }) as Record<string, unknown>;
  }
  const sdk = await loadTransformersSDK();
  const decoded = await Promise.all(images.map((image) => decodeHftImage(sdk, image)));
  const options = { add_special_tokens: false };
  const processor = vlm.processor as unknown as (...args: unknown[]) => Promise<unknown>;
  const inputs = processorTakesImagesFirst(sdk, vlm.processor)
    ? await processor(decoded, prompt, options)
    : await processor(prompt, decoded, options);
  return inputs as Record<string, unknown>;
}

export interface HftVisionGeneration {
  readonly vlm: HftVisionLanguageModel;
  readonly prompt: string;
  readonly images: ReadonlyArray<ContentBlockImage>;
  readonly maxNewTokens: number;
  readonly sampling: HftSamplingOptions;
  /** Each decoded piece of the reply, prompt excluded. */
  readonly onText: (text: string) => void;
  readonly emit: HftStreamEmit;
  readonly signal: AbortSignal | undefined;
}

/**
 * Generate one reply from a vision-language model, streaming it to `onText`.
 *
 * The streamer is the one every text run-fn uses: it skips the prompt, so only
 * new tokens reach `onText`, and it reports prefill and usage. No KV cache is
 * attached or kept. A prefix cache would be reused positionally, and the image
 * features merged into a prompt live in the embeddings of the very positions it
 * would skip, so each round encodes its whole prompt — images included.
 */
export async function generateHftVision(opts: HftVisionGeneration): Promise<void> {
  const { TextStreamer, InterruptableStoppingCriteria } = await loadTransformersSDK();
  const inputs = await encodeHftVisionInputs(opts.vlm, opts.prompt, opts.images);
  const streamer = createStreamingTextStreamer(
    opts.vlm.tokenizer,
    opts.onText,
    TextStreamer,
    opts.emit
  );
  const stopping_criteria = new InterruptableStoppingCriteria();
  if (opts.signal) {
    if (opts.signal.aborted) stopping_criteria.interrupt();
    else opts.signal.addEventListener("abort", () => stopping_criteria.interrupt(), { once: true });
  }
  await opts.vlm.model.generate({
    ...inputs,
    max_new_tokens: opts.maxNewTokens,
    ...opts.sampling,
    streamer,
    stopping_criteria: [stopping_criteria],
  } as Parameters<HftVisionLanguageModel["model"]["generate"]>[0]);
}
