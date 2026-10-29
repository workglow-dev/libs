/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability } from "../capability/Capabilities";

/**
 * Mapping from app task types to HuggingFace pipeline names.
 * Each task type maps to one or more pipelines (first is primary).
 */
const TASK_TO_PIPELINES: Record<string, string[]> = {
  TextEmbeddingTask: ["feature-extraction", "sentence-similarity"],
  TextGenerationTask: ["text-generation"],
  TextSummaryTask: ["summarization"],
  TextTranslationTask: ["translation"],
  TextClassificationTask: ["text-classification", "zero-shot-classification"],
  TextQuestionAnswerTask: ["question-answering"],
  TextFillMaskTask: ["fill-mask"],
  TextLanguageDetectionTask: ["text-classification"],
  TextNamedEntityRecognitionTask: ["token-classification"],
  TokenClassificationTask: ["token-classification"],
  ImageClassificationTask: ["image-classification", "zero-shot-image-classification"],
  ImageEmbeddingTask: ["image-feature-extraction"],
  ImageSegmentationTask: ["image-segmentation"],
  ImageToTextTask: ["image-to-text"],
  ObjectDetectionTask: ["object-detection", "zero-shot-object-detection"],
  AudioClassificationTask: ["audio-classification"],
  SpeechRecognitionTask: ["automatic-speech-recognition"],
};

/**
 * Mapping from HuggingFace pipeline names to canonical capability ids
 * (members of the closed `Capability` vocabulary). Used by model-search
 * results to populate `record.capabilities` from the HF Hub `pipeline_tag`.
 *
 * Multiple pipelines may map to the same capability id (e.g. text-classification
 * + zero-shot-classification both → "text.classification"); duplicates are
 * removed by the consumer.
 */
const PIPELINE_TO_CAPABILITIES: Record<string, readonly Capability[]> = {
  "feature-extraction": ["text.embedding"],
  "sentence-similarity": ["text.embedding"],
  "text-generation": ["text.generation"],
  summarization: ["text.summary"],
  translation: ["text.translation"],
  "text-classification": ["text.classification"],
  "zero-shot-classification": ["text.classification"],
  "question-answering": ["text.question-answering"],
  "fill-mask": ["text.fill-mask"],
  "token-classification": ["text.ner"],
  "image-classification": ["image.classification"],
  "zero-shot-image-classification": ["image.classification", "image.embedding"],
  "image-feature-extraction": ["image.embedding"],
  "image-segmentation": ["image.segmentation"],
  "image-to-text": ["image.to-text"],
  "object-detection": ["image.object-detection"],
  "zero-shot-object-detection": ["image.object-detection"],
};

const TRANSFORMERS_JS_PIPELINE_REMAP: Record<string, string> = {
  "sentence-similarity": "feature-extraction",
};

/** Convert an app task type to its primary HuggingFace pipeline name. */
export function taskTypeToPipeline(taskType: string): string | undefined {
  return TASK_TO_PIPELINES[taskType]?.[0];
}

/** Convert an app task type to all matching HuggingFace pipeline names. */
export function taskTypeToPipelines(taskType: string): string[] {
  return TASK_TO_PIPELINES[taskType] ?? [];
}

/** Reverse lookup: given a HuggingFace pipeline name, return all matching app task types. */
export function pipelineToTaskTypes(pipeline: string): string[] {
  return Object.entries(TASK_TO_PIPELINES)
    .filter(([, pipelines]) => pipelines.includes(pipeline))
    .map(([task]) => task);
}

/**
 * Map a HuggingFace `pipeline_tag` to canonical {@link Capability} ids.
 * Returns an empty array for unknown pipelines (model-search consumers should
 * fall back to the provider's heuristic `inferCapabilities` in that case).
 */
export function pipelineToCapabilities(pipeline: string): readonly Capability[] {
  return PIPELINE_TO_CAPABILITIES[pipeline] ?? [];
}

/** Normalize HuggingFace Hub pipeline tags to pipeline names accepted by Transformers.js. */
export function normalizeTransformersJsPipeline(pipeline: string): string {
  return TRANSFORMERS_JS_PIPELINE_REMAP[pipeline] ?? pipeline;
}
