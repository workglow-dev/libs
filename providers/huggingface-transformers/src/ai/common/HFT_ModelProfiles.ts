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

/**
 * What a HuggingFace Transformers model is for. `unknown` is the fallback's
 * answer: nothing in the name or the config says.
 */
export type HftModelKind =
  | "text-generation"
  | "text-embedding"
  | "text-classification"
  | "token-classification"
  | "fill-mask"
  | "translation"
  | "summarization"
  | "question-answering"
  | "text-reranking"
  | "language-detection"
  | "image-classification"
  | "zero-shot-image-classification"
  | "image-segmentation"
  | "image-to-text"
  | "object-detection"
  | "background-removal"
  | "unknown";

/**
 * What differs per HFT model. HF Hub names are open-ended, so there are no
 * rows: every recognized model comes from a family rule on its repo name, or
 * from the `pipeline_task` hint on its record.
 */
export interface HftModelProfile {
  readonly kind: HftModelKind;
}

const profile = (kind: HftModelKind): HftModelProfile => ({ kind });

const TEXT_GENERATION = profile("text-generation");
const TEXT_EMBEDDING = profile("text-embedding");
const ZERO_SHOT_IMAGE = profile("zero-shot-image-classification");

/**
 * Ordered: the first match wins, so a narrower family sits ahead of a broader
 * one sharing its tokens — rerankers share `bge-` with embedders.
 */
export const HFT_MODEL_FAMILIES: readonly ModelProfileFamily<HftModelProfile>[] = [
  { when: /rerank/, profile: profile("text-reranking") },
  { when: /language.?detect|langid/, profile: profile("language-detection") },
  { when: /embed|minilm|bge-|gte-|e5-/, profile: TEXT_EMBEDDING },
  { when: /clip|siglip/, profile: ZERO_SHOT_IMAGE },
  { when: /yolo|detr|owl/, profile: profile("object-detection") },
  { when: /sam|segformer|mask/, profile: profile("image-segmentation") },
  { when: /blip|llava|vision/, profile: profile("image-to-text") },
  { when: /llama|mistral|gemma|phi|qwen|tinyllama|smollm/, profile: TEXT_GENERATION },
];

/**
 * `provider_config.pipeline_task` values, read ahead of the name: the hint is
 * the HF Hub's own tag for the repo, which a name family can only guess at.
 * A value not listed here falls through to the name.
 */
export const HFT_PIPELINE_TASK_PROFILES: Readonly<Record<string, HftModelProfile>> = {
  "text-generation": TEXT_GENERATION,
  "feature-extraction": TEXT_EMBEDDING,
  "sentence-similarity": TEXT_EMBEDDING,
  "text-classification": profile("text-classification"),
  "token-classification": profile("token-classification"),
  "fill-mask": profile("fill-mask"),
  translation: profile("translation"),
  summarization: profile("summarization"),
  "question-answering": profile("question-answering"),
  "image-classification": profile("image-classification"),
  "image-segmentation": profile("image-segmentation"),
  "image-to-text": profile("image-to-text"),
  "object-detection": profile("object-detection"),
  "background-removal": profile("background-removal"),
  "zero-shot-image-classification": ZERO_SHOT_IMAGE,
};

const UNKNOWN = profile("unknown");

/**
 * The canonical id: the repo name without its owner (`Xenova/clip-vit-base-patch32`
 * → `clip-vit-base-patch32`), lower-cased, so an owner such as `Xenova` or a
 * local folder never matches a family meant for the model itself.
 */
export function normalizeHftModelId(id: string): string {
  const trimmed = id.trim().toLowerCase();
  return trimmed.split("/").pop() ?? trimmed;
}

export type HftResolvedProfile = ResolvedModelProfile<HftModelProfile>;

export const resolveHftProfile: (modelName: string | undefined) => HftResolvedProfile =
  makeModelProfileResolver<HftModelProfile>({
    families: HFT_MODEL_FAMILIES,
    normalize: normalizeHftModelId,
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

/** A record's profile, and whether it came from the `pipeline_task` hint or the name. */
export interface HftRecordProfile {
  readonly profile: HftModelProfile;
  readonly source: "pipeline-task" | ModelProfileSource;
  readonly recognized: boolean;
}

/** The name an HFT record is profiled by: its id, else its repo path, else its model name. */
export function hftModelName(model: ProfileHints): string {
  const config = model.provider_config as
    | { readonly model_path?: string | undefined; readonly model_name?: string | undefined }
    | undefined;
  return String(model.model_id ?? config?.model_path ?? config?.model_name ?? "");
}

/**
 * The profile for a record: its `pipeline_task` hint when it names a task the
 * provider serves, else the profile its name resolves to.
 */
export function resolveHftRecordProfile(model: ProfileHints): HftRecordProfile {
  const pipelineTask = (
    model.provider_config as { readonly pipeline_task?: string | undefined } | undefined
  )?.pipeline_task;
  if (pipelineTask !== undefined && Object.hasOwn(HFT_PIPELINE_TASK_PROFILES, pipelineTask)) {
    return {
      profile: HFT_PIPELINE_TASK_PROFILES[pipelineTask]!,
      source: "pipeline-task",
      recognized: true,
    };
  }
  const { profile: resolved, source, recognized } = resolveHftProfile(hftModelName(model));
  return { profile: resolved, source, recognized };
}

const HFT_META = [
  "model.download",
  "model.download-remove",
  "model.info",
  "model.search",
] as const satisfies readonly Capability[];

const HFT_KIND_CAPABILITIES: Readonly<Record<HftModelKind, readonly Capability[]>> = {
  "text-generation": [
    "text.generation",
    "text.rewriter",
    "text.summary",
    "tool-use",
    "json-mode",
    "cache.checkpoint",
    "session.dispose",
    "model.count-tokens",
    ...HFT_META,
  ],
  "text-embedding": ["text.embedding", ...HFT_META],
  "text-classification": ["text.classification", ...HFT_META],
  "token-classification": ["text.ner", ...HFT_META],
  "fill-mask": ["text.fill-mask", ...HFT_META],
  translation: ["text.translation", ...HFT_META],
  summarization: ["text.summary", ...HFT_META],
  "question-answering": ["text.question-answering", ...HFT_META],
  "text-reranking": ["text.reranking", ...HFT_META],
  "language-detection": ["text.language-detection", ...HFT_META],
  "image-classification": ["image.classification", ...HFT_META],
  "zero-shot-image-classification": ["image.classification", "image.embedding", ...HFT_META],
  "image-segmentation": ["image.segmentation", ...HFT_META],
  "image-to-text": ["image.to-text", ...HFT_META],
  "object-detection": ["image.object-detection", ...HFT_META],
  "background-removal": ["image.background-removal", ...HFT_META],
  // Nothing says what the model does: only the meta-ops that need no answer.
  unknown: ["model.search", "model.info"],
};

/** The task capabilities a profile serves. */
export function hftProfileCapabilities(profile: HftModelProfile): readonly Capability[] {
  return HFT_KIND_CAPABILITIES[profile.kind];
}
