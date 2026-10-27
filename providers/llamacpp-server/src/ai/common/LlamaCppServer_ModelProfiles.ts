/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Capability,
  ModelProfileFallback,
  ModelProfileFamily,
  ResolvedModelProfile,
} from "@workglow/ai/worker";
import { makeModelProfileResolver } from "@workglow/ai/worker";

export interface LlamaCppServerChatProfile {
  readonly kind: "chat";
  /** Takes image input (a multimodal projector loaded beside the weights). */
  readonly vision: boolean;
}

export interface LlamaCppServerEmbeddingProfile {
  readonly kind: "embedding";
}

/**
 * What differs per model a llama.cpp server runs. Capability inference reads
 * this one shape; a server reports nothing about a model's kind, so the file
 * name is all there is to read it from.
 */
export type LlamaCppServerModelProfile = LlamaCppServerChatProfile | LlamaCppServerEmbeddingProfile;

const EMBEDDING: LlamaCppServerEmbeddingProfile = { kind: "embedding" };
const VISION: LlamaCppServerChatProfile = { kind: "chat", vision: true };
const TEXT: LlamaCppServerChatProfile = { kind: "chat", vision: false };

/**
 * A server runs whatever GGUF it was started with, so there are no rows: every
 * answer comes from a family, in order.
 */
export const LLAMACPP_SERVER_MODEL_FAMILIES: readonly ModelProfileFamily<LlamaCppServerModelProfile>[] =
  [
    {
      when: [
        /embed/,
        /^nomic-embed/,
        /^mxbai-embed/,
        /^all-minilm/,
        /^snowflake-arctic-embed/,
        /^bge-/,
        /^gte-/,
      ],
      profile: EMBEDDING,
    },
    { when: /llava|bakllava|-vision\b/, profile: VISION },
  ];

/**
 * Any named file is taken for a text chat model. Cheaper to over-advertise than
 * to miss: a mis-routed model surfaces as a runtime HTTP error, not a capability
 * miss. Only an absent name is not recognized.
 */
function fallback(id: string): ModelProfileFallback<LlamaCppServerModelProfile> {
  return { profile: TEXT, recognized: id.length > 0 };
}

/** The canonical id for a model path or name: its file name, lower-cased. */
export function normalizeLlamaCppServerModelId(id: string): string {
  const lowered = id.trim().toLowerCase();
  return lowered.slice(lowered.lastIndexOf("/") + 1);
}

export type LlamaCppServerResolvedProfile = ResolvedModelProfile<LlamaCppServerModelProfile>;

export const resolveLlamaCppServerProfile: (
  modelName: string | undefined
) => LlamaCppServerResolvedProfile = makeModelProfileResolver<LlamaCppServerModelProfile>({
  families: LLAMACPP_SERVER_MODEL_FAMILIES,
  normalize: normalizeLlamaCppServerModelId,
  fallback,
});

/** The task capabilities a profile serves. */
export function llamaCppServerProfileCapabilities(
  profile: LlamaCppServerModelProfile
): readonly Capability[] {
  switch (profile.kind) {
    case "embedding":
      return ["text.embedding", "model.info", "model.search"];
    case "chat":
      return [
        "text.generation",
        "text.rewriter",
        "text.summary",
        "tool-use",
        ...(profile.vision ? (["vision-input"] as const) : []),
        "model.info",
        "model.search",
      ];
  }
}
