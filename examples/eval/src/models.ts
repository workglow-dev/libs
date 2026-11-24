/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelConfig } from "@workglow/ai";
import { downloadModel } from "@workglow/ai";
import { getAnthropicModelPricing } from "@workglow/anthropic/ai";
import { getDeepSeekModelPricing } from "@workglow/deepseek/ai";
import { getGeminiModelPricing } from "@workglow/google-gemini/ai";
import { getMetaModelPricing } from "@workglow/meta/ai";
import { getOpenAiModelPricing } from "@workglow/openai/ai";
import { getXaiModelPricing } from "@workglow/xai/ai";
import { ggufCacheDir } from "./config";
import { hfAuthHeaders } from "./hf/auth";
import { sanitizeHubRepoId } from "./hf/ids";

export type EvalKind = "classify" | "similarity" | "extract";

const GGUF_PREFIX = "gguf:";

/**
 * Map a model id string to an inline {@link ModelConfig} by its shape, so any
 * model can be named on the command line without a model repository:
 *
 * - `gguf:…` → local node-llama-cpp. The rest is a HuggingFace GGUF reference
 *   (`gguf:org/repo:Quant`, e.g. `gguf:prism-ml/Bonsai-27B-gguf:Q1_0`), an
 *   `hf:`/`https:` URL, or a path to a local `.gguf` file. The explicit prefix
 *   is needed because a GGUF repo id is indistinguishable from an ONNX one.
 * - `org/name` (contains a slash) → local HuggingFace Transformers ONNX;
 *   the pipeline follows the eval kind (`text-generation` for classify,
 *   `feature-extraction` for similarity). Append `:dtype` to override the
 *   quantization (e.g. `onnx-community/Qwen3-0.6B-ONNX:q4`).
 * - `claude-*` → Anthropic
 * - `gpt-*`, `o<n>*`, `chatgpt-*`, `text-embedding-*` → OpenAI
 * - `gemini-*` → Google Gemini
 * - `grok-*` → xAI
 * - `deepseek-*` → DeepSeek
 * - `muse-*` → Meta
 *
 * The slash check runs after the `gguf:` prefix but before the cloud
 * prefixes: hub paths are unambiguous, and org names can legitimately start
 * with a cloud prefix (e.g. `gpt-omni/mini-omni`).
 *
 * Inline configs skip the capability gate (treated as unverified-allow), so
 * newly released model ids work without registering capability lists.
 */
export function resolveModelConfig(id: string, kind: EvalKind): ModelConfig {
  if (id.startsWith(GGUF_PREFIX)) {
    const ref = id.slice(GGUF_PREFIX.length);
    const provider_config: { [key: string]: unknown } = {
      models_dir: ggufCacheDir(),
    };
    if (kind === "similarity") provider_config.embedding = true;
    if (/^(?:hf:|https?:)/.test(ref)) {
      provider_config.model_url = ref;
    } else if (ref.endsWith(".gguf")) {
      provider_config.model_path = ref;
    } else {
      provider_config.model_url = `hf:${ref}`;
    }
    return { provider: "LOCAL_LLAMACPP", provider_config };
  }
  if (id.includes("/")) {
    const [path, dtype] = splitDtype(id);
    return {
      provider: "HF_TRANSFORMERS_ONNX",
      provider_config: {
        model_path: path,
        pipeline: kind === "similarity" ? "feature-extraction" : "text-generation",
        dtype: dtype ?? (kind === "similarity" ? "q8" : "q4"),
      },
    };
  }
  if (/^claude-/.test(id)) {
    return {
      provider: "ANTHROPIC",
      provider_config: { model_name: id },
      pricing: getAnthropicModelPricing(id),
    };
  }
  if (/^(?:gpt-|o\d|chatgpt-|text-embedding-)/.test(id)) {
    return {
      provider: "OPENAI",
      provider_config: { model_name: id },
      pricing: getOpenAiModelPricing(id),
    };
  }
  if (/^gemini-/.test(id)) {
    return {
      provider: "GOOGLE_GEMINI",
      provider_config: { model_name: id },
      pricing: getGeminiModelPricing(id),
    };
  }
  if (/^grok-/.test(id)) {
    return {
      provider: "XAI",
      provider_config: { model_name: id },
      pricing: getXaiModelPricing(id),
    };
  }
  if (/^deepseek-/.test(id)) {
    return {
      provider: "DEEPSEEK",
      provider_config: { model_name: id },
      pricing: getDeepSeekModelPricing(id),
    };
  }
  if (/^muse-/.test(id)) {
    return {
      provider: "META",
      provider_config: { model_name: id },
      pricing: getMetaModelPricing(id),
    };
  }
  throw new Error(
    `cannot infer a provider for model "${id}" — use a claude-*/gpt-*/gemini-*/grok-*/deepseek-*/muse-* ` +
      `cloud id or an org/name HuggingFace ONNX model path`
  );
}

/**
 * Local ONNX embedding models must declare their vector width
 * (`native_dimensions`) for the provider's dimension check. Look it up from
 * the model's `config.json` on the hub (`hidden_size`, or `d_model` for
 * encoder-decoder architectures) when the config doesn't carry one yet.
 */
export async function ensureEmbeddingDimensions(config: ModelConfig): Promise<ModelConfig> {
  if (config.provider !== "HF_TRANSFORMERS_ONNX") return config;
  if (config.provider_config.native_dimensions !== undefined) return config;
  const path = sanitizeHubRepoId(config.provider_config.model_path as string);
  const url = `https://huggingface.co/${path}/resolve/main/config.json`;
  const res = await fetch(url, { headers: hfAuthHeaders() });
  if (!res.ok) {
    throw new Error(`could not read ${path} config.json (${res.status}) to determine dimensions`);
  }
  const modelInfo = (await res.json()) as { hidden_size?: number; d_model?: number };
  const dimensions = modelInfo.hidden_size ?? modelInfo.d_model;
  if (!dimensions) {
    throw new Error(`no hidden_size/d_model in ${path} config.json — cannot infer dimensions`);
  }
  return {
    ...config,
    provider_config: { ...config.provider_config, native_dimensions: dimensions },
  };
}

/**
 * GGUF weights are fetched by an explicit download step (the llama.cpp
 * provider's generation run-fns load from disk only, unlike the ONNX provider
 * which downloads inside its pipeline). Idempotent — an already-downloaded
 * file is reused. No-op for every other provider.
 */
export async function ensureModelDownloaded(config: ModelConfig): Promise<void> {
  if (config.provider !== "LOCAL_LLAMACPP") return;
  if (config.provider_config.model_url === undefined) return;
  await downloadModel({ model: config });
}

function splitDtype(id: string): [string, string | undefined] {
  const colon = id.lastIndexOf(":");
  if (colon <= id.indexOf("/")) return [id, undefined];
  return [id.slice(0, colon), id.slice(colon + 1)];
}

/** Parse the `--models "a,b,c"` flag into trimmed, de-duplicated ids. */
export function parseModelList(models: string): string[] {
  return [
    ...new Set(
      models
        .split(",")
        .map((m) => m.trim())
        .filter((m) => m.length > 0)
    ),
  ];
}
