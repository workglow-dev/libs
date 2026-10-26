/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

export const HF_TRANSFORMERS_ONNX = "HF_TRANSFORMERS_ONNX";
/** Job queue for WebGPU/GPU/Metal HFT models (serialized, concurrency 1). */
export const HF_TRANSFORMERS_ONNX_GPU = `${HF_TRANSFORMERS_ONNX}_gpu`;
/** Job queue for WASM/CPU HFT models. */
export const HF_TRANSFORMERS_ONNX_CPU = `${HF_TRANSFORMERS_ONNX}_cpu`;
export const HTF_CACHE_NAME = "transformers-cache";

export type QuantizationDataType =
  | "auto"
  | "fp32"
  | "fp16"
  | "q8"
  | "int8"
  | "uint8"
  | "q4"
  | "bnb4"
  | "q4f16"
  | "q2"
  | "q2f16"
  | "q1"
  | "q1f16";

export const QuantizationDataType = {
  auto: "auto",
  fp32: "fp32",
  fp16: "fp16",
  q8: "q8",
  int8: "int8",
  uint8: "uint8",
  q4: "q4",
  bnb4: "bnb4",
  q4f16: "q4f16",
  q2: "q2",
  q2f16: "q2f16",
  q1: "q1",
  q1f16: "q1f16",
} as const satisfies Record<QuantizationDataType, QuantizationDataType>;

type TextPipelineUseCase =
  | "fill-mask" // https://huggingface.co/tasks/fill-mask
  | "token-classification" // https://huggingface.co/tasks/token-classification
  | "text-generation" // https://huggingface.co/tasks/text-generation#completion-generation-models
  | "text2text-generation" // https://huggingface.co/tasks/text-generation#text-to-text-generation-models
  | "text-classification" // https://huggingface.co/tasks/text-classification
  | "summarization" // https://huggingface.co/tasks/sentence-similarity
  | "translation" // https://huggingface.co/tasks/translation
  | "feature-extraction" // https://huggingface.co/tasks/feature-extraction
  | "zero-shot-classification" // https://huggingface.co/tasks/zero-shot-classification
  | "question-answering"; // https://huggingface.co/tasks/question-answering

const TextPipelineUseCase = {
  "fill-mask": "fill-mask",
  "token-classification": "token-classification",
  "text-generation": "text-generation",
  "text2text-generation": "text2text-generation",
  "text-classification": "text-classification",
  summarization: "summarization",
  translation: "translation",
  "feature-extraction": "feature-extraction",
  "zero-shot-classification": "zero-shot-classification",
  "question-answering": "question-answering",
} as const satisfies Record<TextPipelineUseCase, TextPipelineUseCase>;

type VisionPipelineUseCase =
  | "background-removal" // https://huggingface.co/tasks/image-segmentation#background-removal
  | "image-segmentation" // https://huggingface.co/tasks/image-segmentation
  | "depth-estimation" // https://huggingface.co/tasks/depth-estimation
  | "image-classification" // https://huggingface.co/tasks/image-classification
  | "image-to-image" // https://huggingface.co/tasks/image-to-image
  | "image-to-text" // https://huggingface.co/tasks/image-to-text
  | "object-detection" // https://huggingface.co/tasks/object-detection
  | "image-feature-extraction"; // https://huggingface.co/tasks/image-feature-extraction

const VisionPipelineUseCase = {
  "background-removal": "background-removal",
  "image-segmentation": "image-segmentation",
  "depth-estimation": "depth-estimation",
  "image-classification": "image-classification",
  "image-to-image": "image-to-image",
  "image-to-text": "image-to-text",
  "object-detection": "object-detection",
  "image-feature-extraction": "image-feature-extraction",
} as const satisfies Record<VisionPipelineUseCase, VisionPipelineUseCase>;

type AudioPipelineUseCase =
  | "audio-classification" // https://huggingface.co/tasks/audio-classification
  | "automatic-speech-recognition" // https://huggingface.co/tasks/automatic-speech-recognition
  | "text-to-speech"; // https://huggingface.co/tasks/text-to-speech

const AudioPipelineUseCase = {
  "audio-classification": "audio-classification",
  "automatic-speech-recognition": "automatic-speech-recognition",
  "text-to-speech": "text-to-speech",
} as const satisfies Record<AudioPipelineUseCase, AudioPipelineUseCase>;

type MultimodalPipelineUseCase =
  | "document-question-answering" // https://huggingface.co/tasks/document-question-answering
  | "image-text-to-text" // https://huggingface.co/tasks/image-text-to-text
  | "image-to-text" // https://huggingface.co/tasks/image-to-text
  | "zero-shot-audio-classification" // https://huggingface.co/tasks/zero-shot-audio-classification
  | "zero-shot-image-classification" // https://huggingface.co/tasks/zero-shot-image-classification
  | "zero-shot-object-detection"; // https://huggingface.co/tasks/zero-shot-object-detection

const MultimodalPipelineUseCase = {
  "document-question-answering": "document-question-answering",
  "image-text-to-text": "image-text-to-text",
  "image-to-text": "image-to-text",
  "zero-shot-audio-classification": "zero-shot-audio-classification",
  "zero-shot-image-classification": "zero-shot-image-classification",
  "zero-shot-object-detection": "zero-shot-object-detection",
} as const satisfies Record<MultimodalPipelineUseCase, MultimodalPipelineUseCase>;

export type PipelineUseCase =
  | TextPipelineUseCase
  | VisionPipelineUseCase
  | AudioPipelineUseCase
  | MultimodalPipelineUseCase;

export const PipelineUseCase = {
  ...TextPipelineUseCase,
  ...VisionPipelineUseCase,
  ...AudioPipelineUseCase,
  ...MultimodalPipelineUseCase,
} as const satisfies Record<PipelineUseCase, PipelineUseCase>;
