/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// Load adaptive first so Workflow.prototype.add/subtract/multiply/divide/sum are registered
// organize-imports-ignore

import "./task/adaptive";

// Register the FETCH_* error-code reconstructor as a module side-effect so
// JobQueueClient can rebuild typed FetchUrl errors from persisted codes
// without statically importing @workglow/tasks.
import { registerErrorCodeReconstructor } from "@workglow/job-queue";
import { buildFetchUrlError } from "./task/FetchUrlJobError";
registerErrorCodeReconstructor("FETCH_", buildFetchUrlError);

export * from "./task/adaptive";
export * from "./task/ArrayTask";
export * from "./task/DateFormatTask";
export * from "./task/DebugLogTask";
export * from "./task/DelayTask";
export * from "./task/DiscordNotifyTask";
export * from "./task/FetchUrlCredentials";
export * from "./task/FetchUrlJobError";
export * from "./task/FetchUrlTask";
export * from "./task/HumanApprovalTask";
export * from "./task/HumanInputTask";
export * from "./task/image/blur/ImageBlurTask";
export * from "./task/image/border/ImageBorderTask";
export * from "./task/image/brightness/ImageBrightnessTask";
export * from "./task/image/contrast/ImageContrastTask";
export * from "./task/image/crop/ImageCropTask";
export * from "./task/image/flip/ImageFlipTask";
export * from "./task/image/grayscale/ImageGrayscaleTask";
export * from "./task/image/imageCodecLimits";
export { ImageFilterTask } from "./task/image/ImageFilterTask";
export type { ImageFilterInput, ImageFilterOutput } from "./task/image/ImageFilterTask";
export * from "./task/image/imageRasterCodecRegistry";
export * from "./task/image/ImageSchemas";
export * from "./task/image/invert/ImageInvertTask";
export * from "./task/image/pixelate/ImagePixelateTask";
export * from "./task/image/posterize/ImagePosterizeTask";
export * from "./task/image/resize/ImageResizeTask";
export * from "./task/image/rotate/ImageRotateTask";
export * from "./task/image/sepia/ImageSepiaTask";
export * from "./task/image/text/ImageTextTask";
export * from "./task/image/threshold/ImageThresholdTask";
export * from "./task/image/tint/ImageTintTask";
export * from "./task/image/transparency/ImageTransparencyTask";
export * from "./task/InputTask";
export * from "./task/JsonPathTask";
export * from "./task/JsonTask";
export * from "./task/LambdaTask";
export * from "./task/MergeTask";
export * from "./task/OutputTask";
export * from "./task/RegexTask";
export * from "./task/scalar/ScalarAbsTask";
export * from "./task/scalar/ScalarAddTask";
export * from "./task/scalar/ScalarCeilTask";
export * from "./task/scalar/ScalarDivideTask";
export * from "./task/scalar/ScalarFloorTask";
export * from "./task/scalar/ScalarMaxTask";
export * from "./task/scalar/ScalarMinTask";
export * from "./task/scalar/ScalarMultiplyTask";
export * from "./task/scalar/ScalarRoundTask";
export * from "./task/scalar/ScalarSubtractTask";
export * from "./task/scalar/ScalarSumTask";
export * from "./task/scalar/ScalarTruncTask";
export * from "./task/SlackNotifyTask";
export * from "./task/SplitTask";
export * from "./task/string/StringConcatTask";
export * from "./task/string/StringIncludesTask";
export * from "./task/string/StringJoinTask";
export * from "./task/string/StringLengthTask";
export * from "./task/string/StringLowerCaseTask";
export * from "./task/string/StringReplaceTask";
export * from "./task/string/StringSliceTask";
export * from "./task/string/StringTemplateTask";
export * from "./task/string/StringTrimTask";
export * from "./task/string/StringUpperCaseTask";
export * from "./task/TemplateTask";
export * from "./task/vector/VectorDistanceTask";
export * from "./task/vector/VectorDivideTask";
export * from "./task/vector/VectorDotProductTask";
export * from "./task/vector/VectorMultiplyTask";
export * from "./task/vector/VectorNormalizeTask";
export * from "./task/vector/VectorScaleTask";
export * from "./task/vector/VectorSubtractTask";
export * from "./task/vector/VectorSumTask";
export * from "./task/WebhookNotifyTask";
export * from "./registerTaskOptions";
export * from "./util/BoundedRegexRunner";
export * from "./util/regexSafety";
export * from "./util/RetryAfter";
export * from "./util/SafeFetch";
export * from "./util/UrlClassifier";
export * from "./util/WebhookPost";
export { applyFilter, hasFilterOp, registerFilterOp } from "@workglow/util/media";
export type { FilterOpFn } from "@workglow/util/media";

import { TaskRegistry } from "@workglow/task-graph";
import { DateFormatTask } from "./task/DateFormatTask";
import { DebugLogTask } from "./task/DebugLogTask";
import { DelayTask } from "./task/DelayTask";
import { DiscordNotifyTask } from "./task/DiscordNotifyTask";
import { FetchUrlTask } from "./task/FetchUrlTask";
import { HumanApprovalTask } from "./task/HumanApprovalTask";
import { HumanInputTask } from "./task/HumanInputTask";
import { ImageBlurTask } from "./task/image/blur/ImageBlurTask";
import { ImageBorderTask } from "./task/image/border/ImageBorderTask";
import { ImageBrightnessTask } from "./task/image/brightness/ImageBrightnessTask";
import { ImageContrastTask } from "./task/image/contrast/ImageContrastTask";
import { ImageCropTask } from "./task/image/crop/ImageCropTask";
import { ImageFlipTask } from "./task/image/flip/ImageFlipTask";
import { ImageGrayscaleTask } from "./task/image/grayscale/ImageGrayscaleTask";
import { ImageInvertTask } from "./task/image/invert/ImageInvertTask";
import { ImagePixelateTask } from "./task/image/pixelate/ImagePixelateTask";
import { ImagePosterizeTask } from "./task/image/posterize/ImagePosterizeTask";
import { ImageResizeTask } from "./task/image/resize/ImageResizeTask";
import { ImageRotateTask } from "./task/image/rotate/ImageRotateTask";
import { ImageSepiaTask } from "./task/image/sepia/ImageSepiaTask";
import { ImageTextTask } from "./task/image/text/ImageTextTask";
import { ImageThresholdTask } from "./task/image/threshold/ImageThresholdTask";
import { ImageTintTask } from "./task/image/tint/ImageTintTask";
import { ImageTransparencyTask } from "./task/image/transparency/ImageTransparencyTask";
import { InputTask } from "./task/InputTask";
import { JsonPathTask } from "./task/JsonPathTask";
import { JsonTask } from "./task/JsonTask";
import { LambdaTask } from "./task/LambdaTask";
import { MergeTask } from "./task/MergeTask";
import { OutputTask } from "./task/OutputTask";
import { RegexTask } from "./task/RegexTask";
import { ScalarAbsTask } from "./task/scalar/ScalarAbsTask";
import { ScalarAddTask } from "./task/scalar/ScalarAddTask";
import { ScalarCeilTask } from "./task/scalar/ScalarCeilTask";
import { ScalarDivideTask } from "./task/scalar/ScalarDivideTask";
import { ScalarFloorTask } from "./task/scalar/ScalarFloorTask";
import { ScalarMaxTask } from "./task/scalar/ScalarMaxTask";
import { ScalarMinTask } from "./task/scalar/ScalarMinTask";
import { ScalarMultiplyTask } from "./task/scalar/ScalarMultiplyTask";
import { ScalarRoundTask } from "./task/scalar/ScalarRoundTask";
import { ScalarSubtractTask } from "./task/scalar/ScalarSubtractTask";
import { ScalarSumTask } from "./task/scalar/ScalarSumTask";
import { ScalarTruncTask } from "./task/scalar/ScalarTruncTask";
import { SlackNotifyTask } from "./task/SlackNotifyTask";
import { SplitTask } from "./task/SplitTask";
import { StringConcatTask } from "./task/string/StringConcatTask";
import { StringIncludesTask } from "./task/string/StringIncludesTask";
import { StringJoinTask } from "./task/string/StringJoinTask";
import { StringLengthTask } from "./task/string/StringLengthTask";
import { StringLowerCaseTask } from "./task/string/StringLowerCaseTask";
import { StringReplaceTask } from "./task/string/StringReplaceTask";
import { StringSliceTask } from "./task/string/StringSliceTask";
import { StringTemplateTask } from "./task/string/StringTemplateTask";
import { StringTrimTask } from "./task/string/StringTrimTask";
import { StringUpperCaseTask } from "./task/string/StringUpperCaseTask";
import { TemplateTask } from "./task/TemplateTask";
import { VectorDistanceTask } from "./task/vector/VectorDistanceTask";
import { VectorDivideTask } from "./task/vector/VectorDivideTask";
import { VectorDotProductTask } from "./task/vector/VectorDotProductTask";
import { VectorMultiplyTask } from "./task/vector/VectorMultiplyTask";
import { VectorNormalizeTask } from "./task/vector/VectorNormalizeTask";
import { VectorScaleTask } from "./task/vector/VectorScaleTask";
import { VectorSubtractTask } from "./task/vector/VectorSubtractTask";
import { VectorSumTask } from "./task/vector/VectorSumTask";
import { WebhookNotifyTask } from "./task/WebhookNotifyTask";

// Centralized registration ensures tasks are available for JSON deserialization
// and prevents tree-shaking issues.
export let registerCommonTasks = () => {
  const tasks = [
    DebugLogTask,
    DelayTask,
    FetchUrlTask,
    HumanApprovalTask,
    HumanInputTask,
    InputTask,
    JsonTask,
    LambdaTask,
    MergeTask,
    OutputTask,
    SplitTask,
    ScalarAbsTask,
    ScalarAddTask,
    ScalarCeilTask,
    ScalarDivideTask,
    ScalarFloorTask,
    ScalarMaxTask,
    ScalarMinTask,
    ScalarMultiplyTask,
    ScalarRoundTask,
    ScalarSubtractTask,
    ScalarSumTask,
    ScalarTruncTask,
    VectorSumTask,
    VectorDistanceTask,
    VectorDivideTask,
    VectorDotProductTask,
    VectorMultiplyTask,
    VectorNormalizeTask,
    VectorScaleTask,
    VectorSubtractTask,
    StringConcatTask,
    StringIncludesTask,
    StringJoinTask,
    StringLengthTask,
    StringLowerCaseTask,
    StringReplaceTask,
    StringSliceTask,
    StringTemplateTask,
    StringTrimTask,
    StringUpperCaseTask,
    JsonPathTask,
    TemplateTask,
    DateFormatTask,
    RegexTask,
    ImageResizeTask,
    ImageCropTask,
    ImageRotateTask,
    ImageFlipTask,
    ImageGrayscaleTask,
    ImageBorderTask,
    ImageTransparencyTask,
    ImageBlurTask,
    ImagePixelateTask,
    ImageInvertTask,
    ImageBrightnessTask,
    ImageContrastTask,
    ImageSepiaTask,
    ImageThresholdTask,
    ImagePosterizeTask,
    ImageTintTask,
    ImageTextTask,
    WebhookNotifyTask,
    SlackNotifyTask,
    DiscordNotifyTask,
  ];
  tasks.map(TaskRegistry.registerTask);
  return tasks;
};
