/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Closed vocabulary of all recognized AI capability identifiers.
 * Use `Capability` (the derived key type) to constrain function parameters and
 * model registration so that unknown strings are rejected at compile time.
 */
export const CAPABILITIES = {
  // Text
  "text.generation": "Free-form text completion / chat",
  "text.embedding": "Text → vector",
  "text.classification": "Single-label / multi-label text classification",
  "text.translation": "Source → target language",
  "text.summary": "Long → short text",
  "text.rewriter": "Style / tone rewrite",
  "text.question-answering": "Extractive / abstractive QA",
  "text.fill-mask": "Masked language modeling",
  "text.ner": "Named entity recognition",
  "text.language-detection": "Detect input language",
  "text.reranking": "Score query/document pairs",
  // Image
  "image.generation": "Text → image",
  "image.editing": "Image + prompt → image",
  "image.classification": "Image → label(s)",
  "image.embedding": "Image → vector",
  "image.segmentation": "Image → mask(s)",
  "image.object-detection": "Image → bounding boxes + labels",
  "image.background-removal": "Image → foreground mask",
  "image.to-text": "Image → caption",
  // Vision (specialized)
  "vision.face-detection": "Faces in an image",
  "vision.face-landmarks": "Facial keypoints",
  "vision.hand-landmarks": "Hand keypoints",
  "vision.pose-landmarks": "Body pose keypoints",
  "vision.gesture": "Hand gesture recognition",
  // Judgment (typed answers to named questions, not generated text)
  "judgment.systemone":
    "Evaluate state against named typed questions (choice / score / noul) in one call",
  // Modifiers (combine with a base capability)
  "tool-use": "Function/tool calling — emit structured tool invocations from input text",
  "json-mode": "Structured-output JSON conformance — emit JSON matching a schema",
  "vision-input": "Accepts image inputs alongside text",
  // Meta-ops on the provider/model itself
  "model.search": "Search this provider's catalog",
  "model.info": "Fetch metadata about a specific model",
  "model.count-tokens": "Tokenize input for cost / context calculation",
  "model.download-remove": "Uncache a model's weights from cache and disk",
  "model.download": "Fetch / cache a model's weights locally (lifecycle)",
  "model.dispose": "Dispose model-resident resources in memory",
  "session.dispose": "Dispose provider resources for a session or checkpoint",
  // Prompt-prefix caching
  "cache.checkpoint": "Warm and snapshot a prompt prefix for reuse (prompt caching / KV state)",
} as const;

export type Capability = keyof typeof CAPABILITIES;
