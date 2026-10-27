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

/**
 * The chat wrapper a session is built with:
 * - `auto` — the one node-llama-cpp resolves from the GGUF's own metadata.
 * - `qwen3` / `qwen3.5` — its `QwenChatWrapper` at that variation, whose
 *   thought segments and tool-call markup the automatic choice gets wrong.
 */
export type LlamaCppChatWrapper = "auto" | "qwen3" | "qwen3.5";

export interface LlamaCppChatProfile {
  readonly kind: "chat";
  readonly chatWrapper: LlamaCppChatWrapper;
}

export interface LlamaCppEmbeddingProfile {
  readonly kind: "embedding";
}

/**
 * What differs per GGUF. Capability inference and the chat wrapper a session
 * is built with read this one shape, so a file cannot be an embedding model to
 * the list and a Qwen chat model to the session.
 */
export type LlamaCppModelProfile = LlamaCppChatProfile | LlamaCppEmbeddingProfile;

const chat = (chatWrapper: LlamaCppChatWrapper): LlamaCppChatProfile => ({
  kind: "chat",
  chatWrapper,
});

/**
 * GGUFs are whatever the user downloaded, so there are no rows: every answer
 * comes from a family, in order. Embedding comes first, so a Qwen 3 embedding
 * file is an embedding model rather than a Qwen chat model.
 */
export const LLAMACPP_MODEL_FAMILIES: readonly ModelProfileFamily<LlamaCppModelProfile>[] = [
  { when: /embed|minilm|bge-|gte-|e5-/, profile: { kind: "embedding" } },
  { when: /\bqwen[\s._-]?3[\s._-]?5\b/, profile: chat("qwen3.5") },
  { when: /\bqwen[\s._-]?3\b/, profile: chat("qwen3") },
];

const GENERATIVE = chat("auto");

/**
 * Any named file is taken for a generative model whose chat wrapper
 * node-llama-cpp chooses. Only an absent name is not recognized.
 */
function fallback(id: string): ModelProfileFallback<LlamaCppModelProfile> {
  return { profile: GENERATIVE, recognized: id.length > 0 };
}

/**
 * The canonical id for a model path, download URI (`hf:user/repo:quant`) or
 * model id: its last path segment, lower-cased. A directory name says nothing
 * about the file in it — `models/embeddings/` holds chat models too.
 */
export function normalizeLlamaCppModelId(id: string): string {
  const lowered = id.trim().toLowerCase();
  return lowered.slice(lowered.lastIndexOf("/") + 1);
}

export type LlamaCppResolvedProfile = ResolvedModelProfile<LlamaCppModelProfile>;

export const resolveLlamaCppProfile: (modelName: string | undefined) => LlamaCppResolvedProfile =
  makeModelProfileResolver<LlamaCppModelProfile>({
    families: LLAMACPP_MODEL_FAMILIES,
    normalize: normalizeLlamaCppModelId,
    fallback,
  });

/** The fields of a model record or config that name its weights. */
export interface LlamaCppModelNames {
  readonly model_id?: unknown;
  readonly provider_config?: unknown;
}

/**
 * The names a model's weights go by, most specific first: the file loaded, the
 * URI it was downloaded from, the record's id. A title or description is
 * display text and is not read: a description naming the model a fine-tune
 * was distilled from would pick that model's chat wrapper.
 */
export function llamaCppModelNames(model: LlamaCppModelNames | undefined): readonly string[] {
  const config = model?.provider_config as
    | { model_path?: unknown; model_url?: unknown; model_name?: unknown }
    | undefined;
  return [config?.model_path, config?.model_url, model?.model_id, config?.model_name].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
}

/**
 * A model's profile: the first of its names a family recognizes, else the
 * fallback for the first name. A file saved under a generic name
 * (`model.gguf`) is still placed by the URI it came from.
 */
export function resolveLlamaCppModelProfile(
  model: LlamaCppModelNames | undefined
): LlamaCppResolvedProfile {
  const names = llamaCppModelNames(model);
  for (const modelName of names) {
    const resolved = resolveLlamaCppProfile(modelName);
    if (resolved.source !== "default") return resolved;
  }
  return resolveLlamaCppProfile(names[0]);
}

/** The `QwenChatWrapper` variation a profile asks for, or none for the automatic wrapper. */
export function llamaCppQwenVariation(profile: LlamaCppModelProfile): "3" | "3.5" | undefined {
  if (profile.kind !== "chat") return undefined;
  switch (profile.chatWrapper) {
    case "qwen3":
      return "3";
    case "qwen3.5":
      return "3.5";
    case "auto":
      return undefined;
  }
}

/** The task capabilities a profile serves. */
export function llamaCppProfileCapabilities(profile: LlamaCppModelProfile): readonly Capability[] {
  switch (profile.kind) {
    case "embedding":
      // No "cache.checkpoint" / "session.dispose": both act on a chat session,
      // which an embedding GGUF has no chat wrapper to build. Advertised, they
      // clear model selection and throw inside the provider; withheld, selection
      // rejects the model and says why.
      return [
        "text.embedding",
        "model.count-tokens",
        "model.download",
        "model.download-remove",
        "model.info",
        "model.search",
      ];
    case "chat":
      return [
        "text.generation",
        "text.rewriter",
        "text.summary",
        "tool-use",
        "json-mode",
        "cache.checkpoint",
        "model.count-tokens",
        "model.download",
        "model.download-remove",
        "model.info",
        "model.search",
        "session.dispose",
      ];
  }
}
