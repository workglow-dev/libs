/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  ModelDownloadTaskRunInput,
  ModelDownloadTaskRunOutput,
} from "@workglow/ai";
import { PermanentJobError } from "@workglow/job-queue";
import { loadTfmpTasksTextSDK, loadTfmpTasksVisionSDK } from "./TFMP_Client";
import { closeGenaiLlm, getGenaiLlm, withGenaiLock } from "./TFMP_GenaiRuntime";
import type { TFMPModelConfig } from "./TFMP_ModelSchema";
import { resolveTfmpRecordProfile } from "./TFMP_ModelProfiles";
import type { TaskInstance } from "./TFMP_Runtime";
import { getModelTask, modelTaskCache, wasm_reference_counts, wasm_tasks } from "./TFMP_Runtime";

/**
 * Core implementation for downloading a TensorFlow MediaPipe model. Resolves
 * the pipeline-specific SDK class from the model's profile (the same answer
 * capability inference reads), materialises the task via
 * {@link getModelTask}, then immediately closes it to release the WASM
 * reference acquired during load — the download itself is the purpose; we
 * don't keep the task alive.
 *
 * Real download progress (0..1, with messages like "Loading WASM task" /
 * "Creating model task") is forwarded via the `emit` callback passed to
 * {@link getModelTask}. The {@link StreamProcessor} consumer re-translates each
 * phase event into task-level `onProgress(percent, message)` callbacks.
 */
export const TFMP_Download: AiProviderRunFn<
  ModelDownloadTaskRunInput,
  ModelDownloadTaskRunOutput,
  TFMPModelConfig
> = async (input, model, signal, emit) => {
  const profile = model ? resolveTfmpRecordProfile(model).profile : undefined;
  const pipeline = profile?.kind === "task" ? profile.pipeline : undefined;
  let task: TaskInstance;
  switch (pipeline) {
    case "text-embedder": {
      const { TextEmbedder } = await loadTfmpTasksTextSDK();
      task = await getModelTask(model!, {}, emit, signal, TextEmbedder);
      break;
    }
    case "text-classifier": {
      const { TextClassifier } = await loadTfmpTasksTextSDK();
      task = await getModelTask(model!, {}, emit, signal, TextClassifier);
      break;
    }
    case "text-language-detector": {
      const { LanguageDetector } = await loadTfmpTasksTextSDK();
      task = await getModelTask(model!, {}, emit, signal, LanguageDetector);
      break;
    }
    case "vision-image-classifier": {
      const { ImageClassifier } = await loadTfmpTasksVisionSDK();
      task = await getModelTask(model!, {}, emit, signal, ImageClassifier);
      break;
    }
    case "vision-image-embedder": {
      const { ImageEmbedder } = await loadTfmpTasksVisionSDK();
      task = await getModelTask(model!, {}, emit, signal, ImageEmbedder);
      break;
    }
    case "vision-image-segmenter": {
      const { ImageSegmenter } = await loadTfmpTasksVisionSDK();
      task = await getModelTask(model!, {}, emit, signal, ImageSegmenter);
      break;
    }
    case "vision-object-detector": {
      const { ObjectDetector } = await loadTfmpTasksVisionSDK();
      task = await getModelTask(model!, {}, emit, signal, ObjectDetector);
      break;
    }
    case "vision-face-detector": {
      const { FaceDetector } = await loadTfmpTasksVisionSDK();
      task = await getModelTask(model!, {}, emit, signal, FaceDetector);
      break;
    }
    case "vision-face-landmarker": {
      const { FaceLandmarker } = await loadTfmpTasksVisionSDK();
      task = await getModelTask(model!, {}, emit, signal, FaceLandmarker);
      break;
    }
    case "vision-gesture-recognizer": {
      const { GestureRecognizer } = await loadTfmpTasksVisionSDK();
      task = await getModelTask(model!, {}, emit, signal, GestureRecognizer);
      break;
    }
    case "vision-hand-landmarker": {
      const { HandLandmarker } = await loadTfmpTasksVisionSDK();
      task = await getModelTask(model!, {}, emit, signal, HandLandmarker);
      break;
    }
    case "vision-pose-landmarker": {
      const { PoseLandmarker } = await loadTfmpTasksVisionSDK();
      task = await getModelTask(model!, {}, emit, signal, PoseLandmarker);
      break;
    }
    case "genai-text": {
      await withGenaiLock(model!.provider_config.model_path, async () => {
        await getGenaiLlm(model!, emit, signal);
      });
      emit({ type: "phase", message: "Pipeline loaded", progress: 0.9 });
      await closeGenaiLlm(model!.provider_config.model_path);
      emit({ type: "finish", data: { model: input.model } });
      return;
    }
    default:
      throw new PermanentJobError(
        `Invalid pipeline: ${model?.provider_config.pipeline}. Supported pipelines: text-embedder, text-classifier, text-language-detector, genai-text, vision-image-classifier, vision-image-embedder, vision-image-segmenter, vision-object-detector, vision-face-detector, vision-face-landmarker, vision-gesture-recognizer, vision-hand-landmarker, vision-pose-landmarker`
      );
  }

  emit({ type: "phase", message: "Pipeline loaded", progress: 0.9 });
  task.close();
  // getModelTask cached this task; drop it so a later call doesn't hand back
  // the now-closed instance.
  modelTaskCache.delete(model!.provider_config.model_path);
  // Release the WASM reference acquired during load, mirroring TFMP_Unload's
  // teardown (and guarding against an absent counter producing NaN).
  const task_engine = model!.provider_config.task_engine!;
  const newCount = (wasm_reference_counts.get(task_engine) ?? 1) - 1;
  if (newCount <= 0) {
    wasm_tasks.delete(task_engine);
    wasm_reference_counts.delete(task_engine);
  } else {
    wasm_reference_counts.set(task_engine, newCount);
  }

  emit({ type: "finish", data: { model: input.model } });
};
