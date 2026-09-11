/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskRegistry } from "@workglow/task-graph";
import { AgentTask } from "./AgentTask";
import { AiChatTask } from "./AiChatTask";
import { AiChatWithKbTask } from "./AiChatWithKbTask";
import { BackgroundRemovalTask } from "./BackgroundRemovalTask";
import { CacheCheckpointTask } from "./CacheCheckpointTask";
import { ChunkRetrievalTask } from "./ChunkRetrievalTask";
import { ChunkVectorUpsertTask } from "./ChunkVectorUpsertTask";
import { ContextBuilderTask } from "./ContextBuilderTask";
import { CountTokensTask } from "./CountTokensTask";
import { DocumentEnricherTask } from "./DocumentEnricherTask";
import { DocumentUpsertTask } from "./DocumentUpsertTask";
import { FaceDetectorTask } from "./FaceDetectorTask";
import { FaceLandmarkerTask } from "./FaceLandmarkerTask";
import { ImageEditTask } from "./generation/ImageEditTask";
import { ImageGenerateTask } from "./generation/ImageGenerateTask";
import { GestureRecognizerTask } from "./GestureRecognizerTask";
import { HandLandmarkerTask } from "./HandLandmarkerTask";
import { HierarchicalChunkerTask } from "./HierarchicalChunkerTask";
import { HierarchyJoinTask } from "./HierarchyJoinTask";
import { ImageClassificationTask } from "./ImageClassificationTask";
import { ImageEmbeddingTask } from "./ImageEmbeddingTask";
import { ImageSegmentationTask } from "./ImageSegmentationTask";
import { ImageToTextTask } from "./ImageToTextTask";
import { KbAddDocumentTask } from "./KbAddDocumentTask";
import { KbDeleteTask } from "./KbDeleteTask";
import { KbReindexTask } from "./KbReindexTask";
import { KbSearchTask } from "./KbSearchTask";
import { KbToDocumentsTask } from "./KbToDocumentsTask";
import { ModelDownloadRemoveTask } from "./ModelDownloadRemoveTask";
import { ModelDownloadTask } from "./ModelDownloadTask";
import { ModelInfoTask } from "./ModelInfoTask";
import { ModelSearchTask } from "./ModelSearchTask";
import { ObjectDetectionTask } from "./ObjectDetectionTask";
import { PoseLandmarkerTask } from "./PoseLandmarkerTask";
import { QueryExpanderTask } from "./QueryExpanderTask";
import { RerankerTask } from "./RerankerTask";
import { StructuralParserTask } from "./StructuralParserTask";
import { StructuredGenerationTask } from "./StructuredGenerationTask";
import { TextChunkerTask } from "./TextChunkerTask";
import { TextClassificationTask } from "./TextClassificationTask";
import { TextEmbeddingTask } from "./TextEmbeddingTask";
import { TextFillMaskTask } from "./TextFillMaskTask";
import { TextGenerationTask } from "./TextGenerationTask";
import { TextLanguageDetectionTask } from "./TextLanguageDetectionTask";
import { TextNamedEntityRecognitionTask } from "./TextNamedEntityRecognitionTask";
import { TextQuestionAnswerTask } from "./TextQuestionAnswerTask";
import { TextRerankerTask } from "./TextRerankerTask";
import { TextRewriterTask } from "./TextRewriterTask";
import { TextSummaryTask } from "./TextSummaryTask";
import { TextTranslationTask } from "./TextTranslationTask";
import { ToolCallingTask } from "./ToolCallingTask";
import { TopicSegmenterTask } from "./TopicSegmenterTask";
import { VectorQuantizeTask } from "./VectorQuantizeTask";
import { VectorSimilarityTask } from "./VectorSimilarityTask";

/**
 * Centralized registration ensures tasks are available for JSON deserialization
 * and prevents tree-shaking issues.
 */
export const registerAiTasks = () => {
  const tasks = [
    AgentTask,
    AiChatTask,
    AiChatWithKbTask,
    BackgroundRemovalTask,
    CacheCheckpointTask,
    CountTokensTask,
    ContextBuilderTask,
    DocumentEnricherTask,
    DocumentUpsertTask,
    ChunkRetrievalTask,
    ChunkVectorUpsertTask,
    ModelDownloadTask,
    ImageEditTask,
    FaceDetectorTask,
    FaceLandmarkerTask,
    ImageGenerateTask,
    GestureRecognizerTask,
    HandLandmarkerTask,
    HierarchicalChunkerTask,
    HierarchyJoinTask,
    KbAddDocumentTask,
    KbDeleteTask,
    KbSearchTask,
    KbToDocumentsTask,
    ImageClassificationTask,
    ImageEmbeddingTask,
    ImageSegmentationTask,
    ImageToTextTask,
    KbReindexTask,
    ModelInfoTask,
    ModelSearchTask,
    ObjectDetectionTask,
    PoseLandmarkerTask,
    QueryExpanderTask,
    RerankerTask,
    StructuralParserTask,
    StructuredGenerationTask,
    TextChunkerTask,
    TextClassificationTask,
    TextEmbeddingTask,
    TextFillMaskTask,
    TextGenerationTask,
    TextLanguageDetectionTask,
    TextNamedEntityRecognitionTask,
    TextQuestionAnswerTask,
    TextRerankerTask,
    TextRewriterTask,
    TextSummaryTask,
    TextTranslationTask,
    ToolCallingTask,
    TopicSegmenterTask,
    ModelDownloadRemoveTask,
    VectorQuantizeTask,
    VectorSimilarityTask,
  ];
  tasks.map(TaskRegistry.registerTask);
  return tasks;
};
