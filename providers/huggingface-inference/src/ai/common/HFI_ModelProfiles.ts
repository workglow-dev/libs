/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Capability,
  ModelIdMatcher,
  ModelProfileFamily,
  ResolvedModelProfile,
} from "@workglow/ai/worker";
import { makeModelProfileResolver } from "@workglow/ai/worker";

/** A chat-completions model: takes the `reasoning_effort` dial and tools. */
export interface HfiChatProfile {
  readonly kind: "chat";
}

export interface HfiEmbeddingProfile {
  readonly kind: "embedding";
}

/** Which output dimensions an aspect ratio maps to. */
export type HfiImageDims = "flux" | "sdxl";

export interface HfiImageProfile {
  readonly kind: "image";
  /** Serves text-to-image. */
  readonly generates: boolean;
  /** Serves image-to-image. */
  readonly edits: boolean;
  /** Takes an inpainting mask on an edit. */
  readonly masks: boolean;
  readonly dims: HfiImageDims;
}

/** A model the router serves that no run-fn here can call: no task, no reasoning dial. */
export interface HfiUnservedProfile {
  readonly kind: "rerank" | "audio";
}

/**
 * What differs per Hugging Face Inference model. Capability inference, the
 * effort policy, image dimensions, mask validation and model search all read
 * this one shape, so a reranker cannot be an embedding model to one site and a
 * non-text model to another.
 */
export type HfiModelProfile =
  | HfiChatProfile
  | HfiEmbeddingProfile
  | HfiImageProfile
  | HfiUnservedProfile;

const CHAT: HfiChatProfile = { kind: "chat" };
const EMBEDDING: HfiEmbeddingProfile = { kind: "embedding" };

const image = (dims: HfiImageDims, masks: boolean): HfiImageProfile => ({
  kind: "image",
  generates: true,
  edits: true,
  masks,
  dims,
});

/**
 * Models whose task the router serves narrower than their family: the Hub's
 * pipeline tag says nothing a search could map to `image.generation` or
 * `image.editing`, so these state it. Keyed by canonical id
 * ({@link normalizeHfiModelId}).
 */
export const HFI_MODEL_PROFILES: Readonly<Record<string, HfiModelProfile>> = {
  "black-forest-labs/flux.1-schnell": {
    kind: "image",
    generates: true,
    edits: false,
    masks: false,
    dims: "flux",
  },
  "black-forest-labs/flux.1-kontext-dev": {
    kind: "image",
    generates: false,
    edits: true,
    masks: true,
    dims: "flux",
  },
};

/** The repo name, without its owner: what most family names are spelled in. */
function repoName(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

/** A matcher over the repo name only, so an owner's name cannot place its every model. */
const inRepoName =
  (pattern: RegExp): ModelIdMatcher =>
  (id) =>
    pattern.test(repoName(id));

const BLACK_FOREST_FLUX = /^black-forest-labs\/flux/;
const INPAINTING = /inpaint|kontext/;
const IMAGE: readonly ModelIdMatcher[] = [
  inRepoName(/flux|stable-diffusion|sd-|sdxl|dall-e|kandinsky|wuerstchen|playground/),
  /stable-diffusion|flux|sdxl/,
  INPAINTING,
];

/**
 * Consulted in order. The modalities no run-fn here serves come first, since
 * their names overlap the ones that are served — `bge-reranker` is not an
 * embedding model and `Qwen3-Reranker` is not a chat model.
 */
export const HFI_MODEL_FAMILIES: readonly ModelProfileFamily<HfiModelProfile>[] = [
  { when: /rerank/, profile: { kind: "rerank" } },
  { when: /(?:^|[/-])(?:whisper|tts)/, profile: { kind: "audio" } },
  {
    when: (id) => BLACK_FOREST_FLUX.test(id) && INPAINTING.test(id),
    profile: image("flux", true),
  },
  { when: BLACK_FOREST_FLUX, profile: image("flux", false) },
  { when: INPAINTING, profile: image("sdxl", true) },
  { when: IMAGE, profile: image("sdxl", false) },
  {
    when: [inRepoName(/embed|minilm|bge-|gte-|e5-/), /embed/, /(?:^|\/)(?:bge|gte|e5)-/],
    profile: EMBEDDING,
  },
  {
    when: inRepoName(/llama|mistral|mixtral|gemma|phi|qwen|falcon|yi|deepseek|command|claude|gpt-/),
    profile: CHAT,
  },
];

/**
 * The canonical id for any spelling of a Hub model. Repo ids are matched
 * without regard to case, and the router's `:provider` / `:fastest` suffix
 * picks a backend for the same model.
 */
export function normalizeHfiModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/:[^/]*$/, "");
}

export type HfiResolvedProfile = ResolvedModelProfile<HfiModelProfile>;

/**
 * An id no row or family names is taken for a chat model, unrecognized: the
 * router forwards to many backends and drops nothing on its own, so it keeps
 * the reasoning dial, but capability inference does not advertise a task for it.
 */
export const resolveHfiProfile: (modelName: string | undefined) => HfiResolvedProfile =
  makeModelProfileResolver<HfiModelProfile>({
    models: HFI_MODEL_PROFILES,
    families: HFI_MODEL_FAMILIES,
    normalize: normalizeHfiModelId,
    fallback: CHAT,
  });

/** The task capabilities a profile serves. */
export function hfiProfileCapabilities(profile: HfiModelProfile): readonly Capability[] {
  switch (profile.kind) {
    case "chat":
      return [
        "text.generation",
        "text.rewriter",
        "text.summary",
        "tool-use",
        "model.info",
        "model.search",
      ];
    case "embedding":
      return ["text.embedding", "model.info", "model.search"];
    case "image":
      return [
        ...(profile.generates ? (["image.generation"] as const) : []),
        ...(profile.edits ? (["image.editing"] as const) : []),
        "model.info",
        "model.search",
      ];
    case "rerank":
    case "audio":
      return ["model.search", "model.info"];
  }
}
