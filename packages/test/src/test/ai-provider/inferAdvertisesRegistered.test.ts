/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability, ModelPricing, ModelRecord } from "@workglow/ai";
import { _testOnly as anthropic } from "@workglow/anthropic/ai";
import { _testOnly as cactus } from "@workglow/cactus/ai";
import { _testOnly as chromeAi } from "@workglow/chrome-ai/ai";
import { _testOnly as deepseek } from "@workglow/deepseek/ai";
import { _testOnly as gemini } from "@workglow/google-gemini/ai";
import { _testOnly as hfi } from "@workglow/huggingface-inference/ai";
import { _testOnly as hft } from "@workglow/huggingface-transformers/ai";
import { _testOnly as llamaServer } from "@workglow/llamacpp-server/ai";
import { _testOnly as llamaCpp } from "@workglow/node-llama-cpp/ai";
import { _testOnly as ollama } from "@workglow/ollama/ai";
import { _testOnly as openai } from "@workglow/openai/ai";
import { _testOnly as openrouter } from "@workglow/openrouter/ai";
import { _testOnly as sdCpp } from "@workglow/stable-diffusion-server/ai";
import { _testOnly as tfmp } from "@workglow/tf-mediapipe/ai";
import { _testOnly as typesafeai } from "@workglow/typesafeai/ai";
import { _testOnly as xai } from "@workglow/xai/ai";
import { describe, expect, it } from "vitest";

import { assertInferAdvertisesRegistered } from "@workglow/test-contract/ai-provider";
import type { InferredForModel } from "@workglow/test-contract/ai-provider";
import { assertInferServesInferred } from "@workglow/test-contract/ai-provider";
import type { PricedModel } from "@workglow/test-contract/ai-provider";
import {
  assertPricedGapDoesNotGrow,
  assertPricingMatchesModality,
} from "@workglow/test-contract/ai-provider";

function model(
  provider: string,
  model_id: string,
  extra: { provider_config?: Record<string, unknown>; metadata?: Record<string, unknown> } = {}
): ModelRecord {
  return {
    model_id,
    title: model_id,
    description: "",
    provider,
    provider_config: { model_name: model_id, model_path: model_id, ...extra.provider_config },
    capabilities: [],
    metadata: extra.metadata ?? {},
  } as ModelRecord;
}

function servesOf(
  specs: readonly { readonly serves: readonly Capability[] }[]
): readonly (readonly string[])[] {
  return specs.map((spec) => spec.serves);
}

/**
 * Keeps each fixture id beside the capabilities inferred for it — the
 * per-model assertion needs both, and deriving one from the other here is what
 * stops the two lists drifting apart.
 */
function inferEach(
  ids: readonly string[],
  infer: (id: string) => readonly Capability[]
): readonly InferredForModel[] {
  return ids.map((id) => ({ id, capabilities: infer(id) }));
}

/**
 * Pairs each fixture id with both what the provider infers for it and what the
 * provider charges for it, from one construction of the provider.
 */
function pricedEach(
  provider: string,
  ids: readonly string[],
  // Each provider narrows these to its own config type, whose `provider` is a
  // string literal — so `ModelRecord` does not satisfy them structurally. `never`
  // accepts every one of those by contravariance, and the cast lands here once
  // rather than at each of the five call sites.
  make: () => {
    inferCapabilities: (record: never) => readonly Capability[];
    modelPricing: (record: never) => ModelPricing | undefined;
  }
): readonly PricedModel[] {
  const instance = make();
  return ids.map((id) => {
    const record = model(provider, id) as never;
    return {
      id,
      capabilities: instance.inferCapabilities(record) as readonly string[],
      pricing: instance.modelPricing(record),
    };
  });
}

const PROVIDER_CASES: readonly {
  readonly name: string;
  readonly registered: readonly (readonly string[])[];
  readonly inferred: readonly InferredForModel[];
}[] = [
  {
    name: "anthropic",
    registered: servesOf(anthropic.ANTHROPIC_RUN_FN_SPECS),
    inferred: inferEach(["claude-sonnet-5"], (id) =>
      new anthropic.AnthropicQueuedProvider(anthropic.ANTHROPIC_RUN_FNS).inferCapabilities(
        model("ANTHROPIC", id)
      )
    ),
  },
  {
    name: "openai",
    registered: servesOf(openai.OPENAI_RUN_FN_SPECS),
    inferred: inferEach(["gpt-4o", "text-embedding-3-small", "dall-e-3", "gpt-image-1"], (id) =>
      new openai.OpenAiQueuedProvider(openai.OPENAI_RUN_FNS).inferCapabilities(model("OPENAI", id))
    ),
  },
  {
    name: "google-gemini",
    registered: servesOf(gemini.GEMINI_RUN_FN_SPECS),
    inferred: inferEach(
      [
        "gemini-2.5-pro",
        "gemini-embedding-001",
        "imagen-4.0-generate-001",
        "gemini-3.1-flash-image",
      ],
      (id) =>
        new gemini.GoogleGeminiQueuedProvider(gemini.GEMINI_RUN_FNS).inferCapabilities(
          model("GOOGLE_GEMINI", id)
        )
    ),
  },
  {
    name: "xai",
    registered: servesOf(xai.XAI_RUN_FN_SPECS),
    inferred: inferEach(["grok-4", "grok-2-image-1212"], (id) =>
      new xai.XaiQueuedProvider(xai.XAI_RUN_FNS).inferCapabilities(model("XAI", id))
    ),
  },
  {
    name: "deepseek",
    registered: servesOf(deepseek.DEEPSEEK_RUN_FN_SPECS),
    inferred: inferEach(["deepseek-v4-flash"], (id) =>
      new deepseek.DeepSeekQueuedProvider(deepseek.DEEPSEEK_RUN_FNS).inferCapabilities(
        model("DEEPSEEK", id)
      )
    ),
  },
  {
    name: "typesafeai",
    registered: servesOf(typesafeai.TYPESAFEAI_RUN_FN_SPECS),
    inferred: inferEach(["jev-latest", "jev-1.13.0"], (id) =>
      new typesafeai.TypeSafeAiQueuedProvider(typesafeai.TYPESAFEAI_RUN_FNS).inferCapabilities(
        model("TYPESAFEAI", id)
      )
    ),
  },
  {
    name: "openrouter",
    registered: servesOf(openrouter.OPENROUTER_RUN_FN_SPECS),
    inferred: [
      {
        id: "openai/gpt-5",
        capabilities: new openrouter.OpenRouterQueuedProvider(
          openrouter.OPENROUTER_RUN_FNS
        ).inferCapabilities(
          model("OPENROUTER", "openai/gpt-5", {
            metadata: {
              architecture: { input_modalities: ["text"] },
              supported_parameters: ["tools", "response_format"],
            },
          })
        ),
      },
    ],
  },
  {
    name: "huggingface-transformers",
    registered: servesOf(hft.HFT_RUN_FN_SPECS),
    inferred: (
      [
        ["onnx-community/Llama-3.2-1B-Instruct-q4f16"],
        ["Xenova/all-MiniLM-L6-v2", { pipeline_task: "feature-extraction" }],
        ["Xenova/modnet", { pipeline_task: "background-removal" }],
        ["Xenova/bge-reranker-base"],
        ["Xenova/language-detection"],
        ["Xenova/clip-vit-base-patch32"],
        ["Xenova/distilbert-base-uncased", { pipeline_task: "text-classification" }],
        ["Xenova/bert-base-ner", { pipeline_task: "token-classification" }],
        ["Xenova/bert-base-uncased", { pipeline_task: "fill-mask" }],
        ["Xenova/t5-small", { pipeline_task: "translation" }],
        ["Xenova/distilbert-base-cased-distilled-squad", { pipeline_task: "question-answering" }],
        ["Xenova/segformer", { pipeline_task: "image-segmentation" }],
        ["Xenova/vit-gpt2", { pipeline_task: "image-to-text" }],
        ["Xenova/yolos-tiny", { pipeline_task: "object-detection" }],
      ] as const
    ).map(([id, pc]) => ({
      id,
      capabilities: new hft.HuggingFaceTransformersQueuedProvider(
        hft.HFT_RUN_FNS
      ).inferCapabilities(model("HF_TRANSFORMERS_ONNX", id, pc ? { provider_config: pc } : {})),
    })),
  },
  {
    name: "huggingface-inference",
    registered: servesOf(hfi.HFI_RUN_FN_SPECS),
    inferred: inferEach(
      [
        "mistralai/Mistral-7B-Instruct-v0.3",
        "Xenova/all-MiniLM-L6-v2",
        "black-forest-labs/FLUX.1-dev",
      ],
      (id) =>
        new hfi.HfInferenceQueuedProvider(hfi.HFI_RUN_FNS).inferCapabilities(
          model("HF_INFERENCE", id)
        )
    ),
  },
  {
    name: "node-llama-cpp",
    registered: servesOf(llamaCpp.LLAMACPP_RUN_FN_SPECS),
    inferred: inferEach(
      ["Mistral-7B-Instruct-v0.3.Q4_K_M.gguf", "nomic-embed-text-v1.5.Q4_K_M.gguf"],
      (id) =>
        new llamaCpp.LlamaCppQueuedProvider(llamaCpp.LLAMACPP_RUN_FNS).inferCapabilities(
          model("LOCAL_LLAMACPP", id)
        )
    ),
  },
  {
    name: "llamacpp-server",
    registered: servesOf(llamaServer.LLAMACPP_SERVER_RUN_FN_SPECS),
    inferred: inferEach(["llama-3-8b-q4_k_m.gguf", "nomic-embed-text.gguf"], (id) =>
      new llamaServer.LlamaCppServerQueuedProvider(
        llamaServer.buildLlamaCppServerRunFns({})
      ).inferCapabilities(model("LOCAL_LLAMACPP_SERVER", id))
    ),
  },
  {
    name: "ollama",
    registered: servesOf(ollama.OLLAMA_RUN_FN_SPECS),
    inferred: inferEach(["llama3.2", "nomic-embed-text", "llava"], (id) =>
      new ollama.OllamaQueuedProvider(ollama.OLLAMA_RUN_FNS).inferCapabilities(model("OLLAMA", id))
    ),
  },
  {
    name: "chrome-ai",
    registered: servesOf(chromeAi.WEB_BROWSER_RUN_FN_SPECS),
    inferred: inferEach(
      [
        "chrome-prompt",
        "chrome-summarizer",
        "chrome-rewriter",
        "chrome-translator",
        "chrome-language-detector",
      ],
      (id) => chromeAi.inferWebBrowserCapabilities(model("WEB_BROWSER", id))
    ),
  },
  {
    name: "tf-mediapipe",
    registered: servesOf(tfmp.TFMP_RUN_FN_SPECS),
    inferred: inferEach(
      [
        "gemma3-1b-it-int4-web.task",
        "gesture_recognizer.task",
        "face_landmarker.task",
        "blaze_face_short_range.tflite",
        "pose_landmarker_lite.task",
        "efficientdet_lite0.tflite",
        "selfie_segmenter.tflite",
        "efficientnet_lite0.tflite",
        "image_embedder.tflite",
        "universal_sentence_encoder.tflite",
        "bert_classifier.tflite",
        "language_detector.tflite",
      ],
      (id) =>
        new tfmp.TensorFlowMediaPipeQueuedProvider(tfmp.TFMP_RUN_FNS).inferCapabilities(
          model("TENSORFLOW_MEDIAPIPE", id)
        )
    ),
  },
  {
    name: "cactus",
    registered: cactus.CACTUS_RUN_FNS.map((r) => r.serves),
    inferred: inferEach(["needle-26m"], (id) =>
      new cactus.CactusQueuedProvider().inferCapabilities(model("LOCAL_CACTUS", id))
    ),
  },
  {
    name: "stable-diffusion-server",
    registered: servesOf(sdCpp.STABLE_DIFFUSION_CPP_RUN_FN_SPECS),
    inferred: inferEach(["sd-1.5.gguf"], (id) =>
      new sdCpp.StableDiffusionCppQueuedProvider(
        sdCpp.buildStableDiffusionCppRunFns({})
      ).inferCapabilities(model("LOCAL_STABLE_DIFFUSION_CPP", id))
    ),
  },
];

/**
 * The pricing half of the same fixtures.
 *
 * Driven off the ids `PROVIDER_CASES` already lists rather than a second list,
 * so a model added for a capability check is priced-checked on the same commit.
 * Only the providers that quote a rate at all appear: the local ones answer
 * `FREE_LOCAL_PRICING` for everything, which says nothing about modality.
 */
const PRICED_CASES: readonly {
  readonly name: string;
  readonly models: readonly PricedModel[];
  /**
   * Non-token-billed ids the provider's own table names outright. Recorded, so
   * that adding an image model to a pricing table is a decision someone writes
   * down rather than something the guard silently tolerates.
   *
   * Gemini's flash and pro image models genuinely bill by token — text tokens
   * in, image tokens out. `imagen-4.0-generate-001` is the doubtful one: $0.03
   * is Imagen's per-IMAGE list price sitting in a per-1M-token field, which is
   * the unit confusion this assertion exists to surface. Left recorded rather
   * than changed here, because correcting it means either a per-image field on
   * `ModelPricing` or dropping a real rate, and neither is a test's call.
   */
  readonly namedByTable: readonly string[];
}[] = [
  {
    name: "anthropic",
    models: pricedEach(
      "ANTHROPIC",
      ["claude-sonnet-5"],
      () => new anthropic.AnthropicQueuedProvider(anthropic.ANTHROPIC_RUN_FNS)
    ),
    namedByTable: [],
  },
  {
    name: "openai",
    models: pricedEach(
      "OPENAI",
      ["gpt-4o", "text-embedding-3-small", "dall-e-3", "gpt-image-1"],
      () => new openai.OpenAiQueuedProvider(openai.OPENAI_RUN_FNS)
    ),
    namedByTable: [],
  },
  {
    name: "google-gemini",
    models: pricedEach(
      "GOOGLE_GEMINI",
      [
        "gemini-2.5-pro",
        "gemini-embedding-001",
        "imagen-4.0-generate-001",
        "gemini-3.1-flash-image",
      ],
      () => new gemini.GoogleGeminiQueuedProvider(gemini.GEMINI_RUN_FNS)
    ),
    namedByTable: ["imagen-4.0-generate-001", "gemini-3.1-flash-image"],
  },
  {
    name: "xai",
    models: pricedEach(
      "XAI",
      ["grok-4", "grok-2-image-1212"],
      () => new xai.XaiQueuedProvider(xai.XAI_RUN_FNS)
    ),
    namedByTable: [],
  },
  {
    name: "deepseek",
    models: pricedEach(
      "DEEPSEEK",
      ["deepseek-v4-flash"],
      () => new deepseek.DeepSeekQueuedProvider(deepseek.DEEPSEEK_RUN_FNS)
    ),
    namedByTable: [],
  },
  {
    name: "typesafeai",
    models: pricedEach(
      "TYPESAFEAI",
      ["jev-latest", "jev-1.13.0"],
      () => new typesafeai.TypeSafeAiQueuedProvider(typesafeai.TYPESAFEAI_RUN_FNS)
    ),
    namedByTable: [],
  },
];

/**
 * Token-billed models with no rate card today.
 *
 * A ratchet, not a target — see `assertPricedGapDoesNotGrow`. A hard assert
 * would redden the build on a gap everyone already knows about.
 */
const KNOWN_UNPRICED: Readonly<Record<string, readonly string[]>> = {
  anthropic: [],
  openai: [],
  "google-gemini": ["gemini-embedding-001"],
  xai: [],
  deepseek: [],
  typesafeai: [],
};

describe("a rate card matches the model's billing unit", () => {
  it.each(PRICED_CASES)(
    "$name does not borrow a per-token rate",
    ({ name, models, namedByTable }) => {
      assertPricingMatchesModality(name, models, namedByTable);
    }
  );

  it.each(PRICED_CASES)("$name prices no fewer models than recorded", ({ name, models }) => {
    assertPricedGapDoesNotGrow(name, models, KNOWN_UNPRICED[name] ?? []);
  });

  it("is not vacuous: the fixtures include a non-token-billed model", () => {
    const imageModels = PRICED_CASES.flatMap(({ models }) =>
      models.filter((m) => m.capabilities.includes("image.generation")).map((m) => m.id)
    );
    expect(imageModels.length).toBeGreaterThan(2);
  });
});

describe("inferCapabilities and registered run-fns agree", () => {
  it.each(PROVIDER_CASES)(
    "$name advertises every registered capability",
    ({ name, registered, inferred }) => {
      assertInferAdvertisesRegistered(
        name,
        registered,
        inferred.map((entry) => entry.capabilities)
      );
    }
  );

  it.each(PROVIDER_CASES)(
    "$name infers only what it can serve for that model",
    ({ name, registered, inferred }) => {
      assertInferServesInferred(name, registered, inferred);
    }
  );
});
