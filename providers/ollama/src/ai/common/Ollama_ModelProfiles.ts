/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Capability,
  ModelIdMatcher,
  ModelProfileFallback,
  ModelProfileFamily,
  ResolvedModelProfile,
} from "@workglow/ai/worker";
import { makeModelProfileResolver } from "@workglow/ai/worker";

/**
 * What the request's `think` field takes:
 * - `none` — nothing; Ollama answers `think: true` with HTTP 400 on a model that cannot think.
 * - `boolean` — `true | false`.
 * - `levels` — `"low" | "medium" | "high"`, and thinking cannot be turned off.
 */
export type OllamaThink = "none" | "boolean" | "levels";

export interface OllamaChatProfile {
  readonly kind: "chat";
  /** Takes image input. */
  readonly vision: boolean;
  readonly think: OllamaThink;
}

/** An embedding model's vector width, for when the server cannot be asked. */
export interface OllamaEmbeddingDimensions {
  readonly native: number;
  readonly mrl: boolean;
}

export interface OllamaEmbeddingProfile {
  readonly kind: "embedding";
  readonly dimensions: OllamaEmbeddingDimensions | undefined;
}

/**
 * What differs per Ollama model. Capability inference, the effort policy, the
 * request's `think` field and the offline dimensions lookup all read this one
 * shape, so a model cannot be an embedding model to the list and a thinking
 * model to the request.
 */
export type OllamaModelProfile = OllamaChatProfile | OllamaEmbeddingProfile;

const chat = (vision: boolean, think: OllamaThink): OllamaChatProfile => ({
  kind: "chat",
  vision,
  think,
});

const embedding = (dimensions: OllamaEmbeddingDimensions | undefined): OllamaEmbeddingProfile => ({
  kind: "embedding",
  dimensions,
});

/**
 * The model name without its tag. Ollama names carry their variant in the tag
 * (`qwen3:30b-a3b-instruct-2507`), so the tag stays on the canonical id for the
 * families that read it; the name-shaped families read only this.
 */
function baseName(id: string): string {
  const colon = id.indexOf(":");
  return colon === -1 ? id : id.slice(0, colon);
}

const onName =
  (pattern: RegExp): ModelIdMatcher =>
  (id) =>
    pattern.test(baseName(id));

const exactName =
  (expected: string): ModelIdMatcher =>
  (id) =>
    baseName(id) === expected;

const EMBEDDING: readonly ModelIdMatcher[] = [
  /^nomic-embed/,
  /^mxbai-embed/,
  /^all-minilm/,
  /^snowflake-arctic-embed/,
  /^bge-/,
  /^gte-/,
  /(^|-)embed(ding)?($|[-:])/,
].map(onName);

const VISION: readonly ModelIdMatcher[] = [/^llava/, /^bakllava/, /-vision\b/].map(onName);

const GPT_OSS: ModelIdMatcher = /^gpt-oss/;

/**
 * The qwen3 tags that cannot think: the coder and embedding models, and the
 * `-instruct` releases, whose marker is in the tag.
 */
const QWEN3_NON_THINKING = /^qwen3(?:-(?:coder|embedding)|.*instruct)/;

/** Families Ollama marks as thinking-capable; they take `think: true | false`. */
const THINKING: readonly ModelIdMatcher[] = [
  (id) => /^qwen3/.test(id) && !QWEN3_NON_THINKING.test(id),
  /^deepseek-r1/,
  /^deepseek-v3\.[1-9]/,
  /^magistral/,
  /^qwq/,
  /^phi4-reasoning/,
  /^cogito/,
  /^granite3\.[2-9]/,
];

const matchesAny = (matchers: readonly ModelIdMatcher[], id: string): boolean =>
  matchers.some((matcher) => (typeof matcher === "function" ? matcher(id) : matcher.test(id)));

/**
 * Ollama's model space is whatever the user pulled, so there are no rows: every
 * answer comes from a family, in order. The embedding widths are the offline
 * fallback for `ModelInfoTask`; a running server's `show` answer comes first.
 */
export const OLLAMA_MODEL_FAMILIES: readonly ModelProfileFamily<OllamaModelProfile>[] = [
  { when: exactName("nomic-embed-text"), profile: embedding({ native: 768, mrl: false }) },
  { when: exactName("mxbai-embed-large"), profile: embedding({ native: 1024, mrl: false }) },
  { when: exactName("all-minilm"), profile: embedding({ native: 384, mrl: false }) },
  { when: exactName("snowflake-arctic-embed"), profile: embedding({ native: 1024, mrl: false }) },
  { when: EMBEDDING, profile: embedding(undefined) },
  // A vision tag of a thinking family (granite3.2-vision) keeps both.
  {
    when: (id) => matchesAny(VISION, id) && matchesAny(THINKING, id),
    profile: chat(true, "boolean"),
  },
  { when: VISION, profile: chat(true, "none") },
  // gpt-oss takes a level and cannot turn thinking off.
  { when: GPT_OSS, profile: chat(false, "levels") },
  { when: THINKING, profile: chat(false, "boolean") },
];

/** Any other named model: a text chat model that does not think. */
const PLAIN_CHAT = chat(false, "none");

/**
 * Any named model is taken for a chat model. Cheaper to over-advertise than to
 * miss: Ollama surfaces an unsupported feature as a runtime error, not a
 * capability miss. Only an absent name is not recognized.
 */
function fallback(id: string): ModelProfileFallback<OllamaModelProfile> {
  return { profile: PLAIN_CHAT, recognized: id.length > 0 };
}

/**
 * The canonical id for any spelling of an Ollama model: the registry host and
 * namespace (`library/`, `hf.co/<user>/`, `registry.ollama.ai/library/`) and
 * the default `:latest` tag name the same model. Any other tag is kept, since
 * Ollama spells a variant there.
 */
export function normalizeOllamaModelId(id: string): string {
  const lowered = id.trim().toLowerCase();
  const named = lowered.slice(lowered.lastIndexOf("/") + 1);
  return named.endsWith(":latest") ? named.slice(0, -":latest".length) : named;
}

export type OllamaResolvedProfile = ResolvedModelProfile<OllamaModelProfile>;

export const resolveOllamaProfile: (modelName: string | undefined) => OllamaResolvedProfile =
  makeModelProfileResolver<OllamaModelProfile>({
    families: OLLAMA_MODEL_FAMILIES,
    normalize: normalizeOllamaModelId,
    fallback,
  });

/** The task capabilities a profile serves. */
export function ollamaProfileCapabilities(profile: OllamaModelProfile): readonly Capability[] {
  switch (profile.kind) {
    case "embedding":
      return ["text.embedding", "model.info", "model.search"];
    case "chat":
      return [
        "text.generation",
        "text.rewriter",
        "text.summary",
        "tool-use",
        "json-mode",
        ...(profile.vision ? (["vision-input"] as const) : []),
        "model.info",
        "model.search",
      ];
  }
}
