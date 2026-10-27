/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Capability,
  ModelProfileFamily,
  ModelProfileSource,
  ResolvedModelProfile,
} from "@workglow/ai/worker";
import { makeModelProfileResolver } from "@workglow/ai/worker";
import type { TextPipelineTask } from "./TFMP_Constants";

/**
 * The MediaPipe pipelines this provider can load: each names the task class
 * a model file is opened with (`TextEmbedder`, `HandLandmarker`, the genai
 * `LlmInference`, …). The rest of `TextPipelineTask` has no run-fn here.
 */
export type TfmpServedPipeline = Extract<
  TextPipelineTask,
  | "genai-text"
  | "text-embedder"
  | "text-classifier"
  | "text-language-detector"
  | "vision-image-classifier"
  | "vision-image-embedder"
  | "vision-image-segmenter"
  | "vision-object-detector"
  | "vision-face-detector"
  | "vision-face-landmarker"
  | "vision-gesture-recognizer"
  | "vision-hand-landmarker"
  | "vision-pose-landmarker"
>;

export interface TfmpTaskProfile {
  readonly kind: "task";
  readonly pipeline: TfmpServedPipeline;
}

/** The fallback's answer: nothing says which task class opens the file. */
export interface TfmpUnknownProfile {
  readonly kind: "unknown";
}

/**
 * What differs per MediaPipe model: which pipeline opens it. Capability
 * inference and the download run-fn both read this one answer, so a file
 * cannot be advertised as one task and loaded as another.
 */
export type TfmpModelProfile = TfmpTaskProfile | TfmpUnknownProfile;

const task = (pipeline: TfmpServedPipeline): TfmpTaskProfile => ({ kind: "task", pipeline });

/** Every served pipeline's profile, so a record's `pipeline` and a family share one object. */
const PIPELINE_PROFILES: Readonly<Record<TfmpServedPipeline, TfmpTaskProfile>> = {
  "genai-text": task("genai-text"),
  "text-embedder": task("text-embedder"),
  "text-classifier": task("text-classifier"),
  "text-language-detector": task("text-language-detector"),
  "vision-image-classifier": task("vision-image-classifier"),
  "vision-image-embedder": task("vision-image-embedder"),
  "vision-image-segmenter": task("vision-image-segmenter"),
  "vision-object-detector": task("vision-object-detector"),
  "vision-face-detector": task("vision-face-detector"),
  "vision-face-landmarker": task("vision-face-landmarker"),
  "vision-gesture-recognizer": task("vision-gesture-recognizer"),
  "vision-hand-landmarker": task("vision-hand-landmarker"),
  "vision-pose-landmarker": task("vision-pose-landmarker"),
};

/**
 * MediaPipe ships one canonical file per task (`efficientdet_lite0.tflite`,
 * `gesture_recognizer.task`), so the file name says which pipeline opens it.
 * Ordered: the first match wins.
 */
export const TFMP_MODEL_FAMILIES: readonly ModelProfileFamily<TfmpModelProfile>[] = [
  // LLM bundles for the genai engine (Gemma/Qwen `.task` and `.litertlm` files).
  // `llm` only as a whole token, so `hand_landmarker` is not read as one.
  {
    when: /gemma|qwen|\.litertlm$|(?:^|[-_])llm(?:[-_.]|$)/,
    profile: PIPELINE_PROFILES["genai-text"],
  },
  // The gesture recognizer is matched before the hand landmarker it embeds.
  { when: /gesture_recognizer/, profile: PIPELINE_PROFILES["vision-gesture-recognizer"] },
  { when: /hand_landmarker/, profile: PIPELINE_PROFILES["vision-hand-landmarker"] },
  { when: /face_landmarker/, profile: PIPELINE_PROFILES["vision-face-landmarker"] },
  { when: /face_detector|blaze_face/, profile: PIPELINE_PROFILES["vision-face-detector"] },
  { when: /pose_landmarker/, profile: PIPELINE_PROFILES["vision-pose-landmarker"] },
  {
    when: /object_detector|efficientdet|ssd_mobilenet|yolo/,
    profile: PIPELINE_PROFILES["vision-object-detector"],
  },
  { when: /segmenter|deeplab|selfie/, profile: PIPELINE_PROFILES["vision-image-segmenter"] },
  {
    when: /image_classifier|efficientnet|mobilenet/,
    profile: PIPELINE_PROFILES["vision-image-classifier"],
  },
  { when: /image_embed/, profile: PIPELINE_PROFILES["vision-image-embedder"] },
  {
    when: /text_embed|universal_sentence_encoder|use_/,
    profile: PIPELINE_PROFILES["text-embedder"],
  },
  { when: /text_classifier|bert_classifier/, profile: PIPELINE_PROFILES["text-classifier"] },
  { when: /language_detector/, profile: PIPELINE_PROFILES["text-language-detector"] },
];

const UNKNOWN: TfmpUnknownProfile = { kind: "unknown" };

/**
 * The canonical id: the file name, lower-cased — the last segment of a path
 * or URL, since the directories (`mediapipe-models/image_embedder/mobilenet_v3_small/…`)
 * name things other than the file.
 */
export function normalizeTfmpModelId(id: string): string {
  const trimmed = id.trim().toLowerCase();
  return trimmed.split("/").pop() ?? trimmed;
}

export type TfmpResolvedProfile = ResolvedModelProfile<TfmpModelProfile>;

export const resolveTfmpProfile: (modelName: string | undefined) => TfmpResolvedProfile =
  makeModelProfileResolver<TfmpModelProfile>({
    families: TFMP_MODEL_FAMILIES,
    normalize: normalizeTfmpModelId,
    fallback: UNKNOWN,
  });

/**
 * The fields a profile is read from. Optional, as on a model config, so both a
 * stored record and the config a run-fn receives satisfy it.
 */
interface ProfileHints {
  readonly model_id?: string | undefined;
  readonly provider_config?: unknown;
}

/** A record's profile, and whether it came from its `pipeline` or its file name. */
export interface TfmpRecordProfile {
  readonly profile: TfmpModelProfile;
  readonly source: "pipeline" | ModelProfileSource;
  readonly recognized: boolean;
}

function isServedPipeline(value: unknown): value is TfmpServedPipeline {
  return typeof value === "string" && Object.hasOwn(PIPELINE_PROFILES, value);
}

/** The name a MediaPipe record is profiled by: its id, else its file path, else its model name. */
export function tfmpModelName(model: ProfileHints): string {
  const config = model.provider_config as
    | { readonly model_path?: string | undefined; readonly model_name?: string | undefined }
    | undefined;
  return String(model.model_id ?? config?.model_path ?? config?.model_name ?? "");
}

/**
 * The profile for a record: its `provider_config.pipeline` when that names a
 * pipeline this provider serves — it is what the download opens the file
 * with — else the profile its file name resolves to.
 */
export function resolveTfmpRecordProfile(model: ProfileHints): TfmpRecordProfile {
  const pipeline = (model.provider_config as { readonly pipeline?: unknown } | undefined)?.pipeline;
  if (isServedPipeline(pipeline)) {
    return { profile: PIPELINE_PROFILES[pipeline], source: "pipeline", recognized: true };
  }
  const { profile, source, recognized } = resolveTfmpProfile(tfmpModelName(model));
  return { profile, source, recognized };
}

const TFMP_META = [
  "model.download",
  "model.download-remove",
  "model.info",
  "model.search",
] as const satisfies readonly Capability[];

const TFMP_PIPELINE_CAPABILITIES: Readonly<Record<TfmpServedPipeline, readonly Capability[]>> = {
  "genai-text": ["text.generation", "json-mode", "model.count-tokens", ...TFMP_META],
  "vision-gesture-recognizer": ["vision.gesture", "vision.hand-landmarks", ...TFMP_META],
  "vision-hand-landmarker": ["vision.hand-landmarks", ...TFMP_META],
  "vision-face-landmarker": ["vision.face-landmarks", ...TFMP_META],
  "vision-face-detector": ["vision.face-detection", ...TFMP_META],
  "vision-pose-landmarker": ["vision.pose-landmarks", ...TFMP_META],
  "vision-object-detector": ["image.object-detection", ...TFMP_META],
  "vision-image-segmenter": ["image.segmentation", ...TFMP_META],
  "vision-image-classifier": ["image.classification", ...TFMP_META],
  "vision-image-embedder": ["image.embedding", ...TFMP_META],
  "text-embedder": ["text.embedding", ...TFMP_META],
  "text-classifier": ["text.classification", ...TFMP_META],
  "text-language-detector": ["text.language-detection", ...TFMP_META],
};

/** The task capabilities a profile serves. */
export function tfmpProfileCapabilities(profile: TfmpModelProfile): readonly Capability[] {
  switch (profile.kind) {
    case "task":
      return TFMP_PIPELINE_CAPABILITIES[profile.pipeline];
    case "unknown":
      return ["model.search", "model.info"];
  }
}
