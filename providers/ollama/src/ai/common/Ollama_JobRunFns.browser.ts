/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFnRegistration, ToolCallingTaskInput } from "@workglow/ai";
import {
  OLLAMA_JSON_MODE,
  OLLAMA_MODEL_INFO,
  OLLAMA_MODEL_SEARCH,
  OLLAMA_TEXT_EMBEDDING,
  OLLAMA_TEXT_GENERATION,
  OLLAMA_TEXT_REWRITER,
  OLLAMA_TEXT_SUMMARY,
  OLLAMA_TOOL_USE,
} from "./Ollama_CapabilitySets";
import { getClient } from "./Ollama_Client.browser";
import { createOllamaModelInfoStream } from "./Ollama_ModelInfo";
import type { OllamaModelConfig } from "./Ollama_ModelSchema";
import { createOllamaModelSearchStream } from "./Ollama_ModelSearch";
import { createOllamaStructuredGenerationStream } from "./Ollama_StructuredGeneration";
import { createOllamaTextEmbeddingStream } from "./Ollama_TextEmbedding";
import { createOllamaTextGenerationStream } from "./Ollama_TextGeneration";
import { createOllamaTextRewriterStream } from "./Ollama_TextRewriter";
import { createOllamaTextSummaryStream } from "./Ollama_TextSummary";
import { createOllamaToolCallingStream } from "./Ollama_ToolCalling";

function buildBrowserToolCallingMessages(input: ToolCallingTaskInput): Array<{
  role: string;
  content: string;
}> {
  const messages: Array<{ role: string; content: string }> = [];
  if (input.systemPrompt) {
    messages.push({ role: "system", content: input.systemPrompt as string });
  }
  messages.push({ role: "user", content: input.prompt as string });
  return messages;
}

export const Ollama_TextGeneration_Stream = createOllamaTextGenerationStream(getClient);
export const Ollama_StructuredGeneration_Stream = createOllamaStructuredGenerationStream(getClient);
export const Ollama_TextRewriter_Stream = createOllamaTextRewriterStream(getClient);
export const Ollama_TextSummary_Stream = createOllamaTextSummaryStream(getClient);
export const Ollama_TextEmbedding_Stream = createOllamaTextEmbeddingStream(getClient);
export const Ollama_ToolCalling_Stream = createOllamaToolCallingStream(
  getClient,
  buildBrowserToolCallingMessages
);
export const Ollama_ModelInfo_Stream = createOllamaModelInfoStream(getClient);
export const Ollama_ModelSearch_Stream = createOllamaModelSearchStream(getClient);

export const OLLAMA_RUN_FNS: readonly AiProviderRunFnRegistration<any, any, OllamaModelConfig>[] = [
  { serves: OLLAMA_TEXT_GENERATION, runFn: Ollama_TextGeneration_Stream },
  { serves: OLLAMA_TOOL_USE, runFn: Ollama_ToolCalling_Stream },
  { serves: OLLAMA_JSON_MODE, runFn: Ollama_StructuredGeneration_Stream },
  { serves: OLLAMA_TEXT_REWRITER, runFn: Ollama_TextRewriter_Stream },
  { serves: OLLAMA_TEXT_SUMMARY, runFn: Ollama_TextSummary_Stream },
  { serves: OLLAMA_TEXT_EMBEDDING, runFn: Ollama_TextEmbedding_Stream },
  { serves: OLLAMA_MODEL_SEARCH, runFn: Ollama_ModelSearch_Stream },
  { serves: OLLAMA_MODEL_INFO, runFn: Ollama_ModelInfo_Stream },
];
