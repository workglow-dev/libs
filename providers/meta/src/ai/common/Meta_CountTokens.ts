/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderPreviewRunFn,
  AiProviderRunFn,
  CountTokensTaskInput,
  CountTokensTaskOutput,
} from "@workglow/ai";
import type { Tiktoken, TiktokenModel } from "tiktoken";
import { getModelName } from "./Meta_Client";
import type { MetaModelConfig } from "./Meta_ModelSchema";

let _tiktoken: typeof import("tiktoken") | undefined;

async function loadTiktoken(): Promise<typeof import("tiktoken")> {
  if (!_tiktoken) {
    try {
      _tiktoken = await import("tiktoken");
    } catch {
      throw new Error(
        "tiktoken is required for Meta token counting. Install it with: bun add tiktoken"
      );
    }
  }
  return _tiktoken;
}

const _encoderCache = new Map<string, Tiktoken>();

// Meta publishes no tokenizer for the Muse models (its only exact count is a
// Responses-API endpoint), so token counts are approximated with tiktoken's
// cl100k_base encoding (Muse model ids are unknown to
// `encoding_for_model`, so the fallback path is the normal case here).
async function getEncoder(modelName: string): Promise<Tiktoken> {
  const tiktoken = await loadTiktoken();
  if (!_encoderCache.has(modelName)) {
    try {
      _encoderCache.set(modelName, tiktoken.encoding_for_model(modelName as TiktokenModel));
    } catch {
      const fallback = "cl100k_base";
      if (!_encoderCache.has(fallback)) {
        _encoderCache.set(fallback, tiktoken.get_encoding(fallback));
      }
      _encoderCache.set(modelName, _encoderCache.get(fallback)!);
    }
  }
  return _encoderCache.get(modelName)!;
}

async function countTokens(
  input: CountTokensTaskInput,
  model: MetaModelConfig | undefined
): Promise<CountTokensTaskOutput> {
  const enc = await getEncoder(getModelName(model));
  const tokens = enc.encode(input.text);
  return { count: tokens.length };
}

/**
 * One-shot run-fn for `["model.count-tokens"]`. Emits a single `finish` event
 * carrying the token count.
 */
export const Meta_CountTokens_Stream: AiProviderRunFn<
  CountTokensTaskInput,
  CountTokensTaskOutput,
  MetaModelConfig
> = async (input, model, _signal, emit) => {
  const result = await countTokens(input, model);
  emit({ type: "finish", data: result });
};

/** Lightweight preview path used by `AiTask.executePreview()`. */
export const Meta_CountTokens_Preview: AiProviderPreviewRunFn<
  CountTokensTaskInput,
  CountTokensTaskOutput,
  MetaModelConfig
> = async (input, model) => {
  return countTokens(input, model);
};
