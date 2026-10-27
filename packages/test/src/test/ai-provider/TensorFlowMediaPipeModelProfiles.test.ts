/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly as tfmp } from "@workglow/tf-mediapipe/ai";
import { describe, expect, it } from "vitest";
import { describeModelProfileContract } from "./modelProfileContract";

const {
  normalizeTfmpModelId,
  resolveTfmpProfile,
  resolveTfmpRecordProfile,
  tfmpProfileCapabilities,
  inferTfmpCapabilities,
} = tfmp;

const record = (model_id: string, provider_config: Record<string, unknown> = {}) =>
  ({ model_id, provider_config: { model_path: model_id, ...provider_config } }) as never;

const EXPECTED_PIPELINE: Readonly<Record<string, string>> = {
  "hand_landmarker.task": "vision-hand-landmarker",
  "gesture_recognizer.task": "vision-gesture-recognizer",
  "face_landmarker.task": "vision-face-landmarker",
  "blaze_face_short_range.tflite": "vision-face-detector",
  "pose_landmarker_lite.task": "vision-pose-landmarker",
  "efficientdet_lite0.tflite": "vision-object-detector",
  "selfie_segmenter.tflite": "vision-image-segmenter",
  "deeplabv3.tflite?generation=1661875711618421": "vision-image-segmenter",
  "efficientnet_lite0.tflite": "vision-image-classifier",
  "image_embedder.tflite": "vision-image-embedder",
  "universal_sentence_encoder.tflite": "text-embedder",
  "bert_classifier.tflite": "text-classifier",
  "language_detector.tflite": "text-language-detector",
  "gemma3-1b-it-int4.litertlm": "genai-text",
  "Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv1280.task": "genai-text",
  "https://example.com/models/my-llm-int8.task": "genai-text",
};

describeModelProfileContract({
  provider: "TF MediaPipe",
  resolve: resolveTfmpProfile,
  rows: {},
  normalize: normalizeTfmpModelId,
  normalizes: [
    [
      "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      "hand_landmarker.task",
    ],
    ["Gemma3-1B-IT-int4.litertlm", "gemma3-1b-it-int4.litertlm"],
  ],
  unlisted: [
    ...Object.keys(EXPECTED_PIPELINE).map((name) => [name, "family", true] as const),
    ["yamnet.tflite", "default", false],
    ["", "default", false],
  ],
  agrees: (name, profile, recognized) => {
    expect(recognized).toBe(profile.kind === "task");
    if (profile.kind === "task") {
      expect([name, profile.pipeline]).toEqual([name, EXPECTED_PIPELINE[name]]);
    }
    // Inference and the download run-fn read the record's profile; with no
    // `pipeline` on the record it is the file name's.
    const resolved = resolveTfmpRecordProfile(record(name));
    expect(resolved.profile).toBe(profile);
    expect(inferTfmpCapabilities(record(name))).toEqual(tfmpProfileCapabilities(profile));
    if (!recognized)
      expect(inferTfmpCapabilities(record(name))).toEqual(["model.search", "model.info"]);
  },
});

describe("TF MediaPipe record profile", () => {
  it("does not read `llm` inside another word as a genai bundle", () => {
    expect(resolveTfmpProfile("hand_landmarker.task").profile).toEqual({
      kind: "task",
      pipeline: "vision-hand-landmarker",
    });
  });

  it("reads a served `pipeline` ahead of the file name, as the download does", () => {
    const mobilenetEmbedder = record("mobilenet_v3_small.tflite", {
      pipeline: "vision-image-embedder",
    });
    expect(resolveTfmpRecordProfile(mobilenetEmbedder).profile).toEqual({
      kind: "task",
      pipeline: "vision-image-embedder",
    });
    expect(inferTfmpCapabilities(mobilenetEmbedder)).toContain("image.embedding");
    expect(inferTfmpCapabilities(mobilenetEmbedder)).not.toContain("image.classification");
  });

  it("falls back to the file name for a `pipeline` it does not serve", () => {
    const resolved = resolveTfmpRecordProfile(
      record("efficientnet_lite0.tflite", { pipeline: "audio-classifier" })
    );
    expect([resolved.source, resolved.profile]).toEqual([
      "family",
      { kind: "task", pipeline: "vision-image-classifier" },
    ]);
  });
});
