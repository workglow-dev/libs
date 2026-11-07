/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChunkRecord } from "@workglow/knowledge-base";
import { ChunkRecordArraySchema } from "@workglow/knowledge-base";
import { CreateWorkflow, Task, TaskInvalidInputError, Workflow } from "@workglow/task-graph";

import type { IExecuteContext, IRunConfig, TaskConfig } from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import type { Capability } from "../capability/Capabilities";

export const ChunkingStrategy = {
  FIXED: "fixed",
  SENTENCE: "sentence",
  PARAGRAPH: "paragraph",
  SEMANTIC: "semantic",
} as const;

export type ChunkingStrategy = (typeof ChunkingStrategy)[keyof typeof ChunkingStrategy];

const inputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      title: "Text",
      description: "The text to chunk",
    },
    doc_id: {
      type: "string",
      title: "Document ID",
      description:
        "Optional document ID stamped onto each chunk. When omitted, chunks are emitted without a doc_id and the output also has no doc_id.",
    },
    chunkSize: {
      type: "number",
      title: "Chunk Size",
      description: "Maximum size of each chunk in characters",
      minimum: 1,
      default: 512,
    },
    chunkOverlap: {
      type: "number",
      title: "Chunk Overlap",
      description:
        "Number of characters to overlap between chunks; must be smaller than the chunk size. Defaults to 50, or one less than the chunk size when that is smaller",
      minimum: 0,
    },
    strategy: {
      type: "string",
      enum: Object.values(ChunkingStrategy),
      title: "Chunking Strategy",
      description: "Strategy to use for chunking text",
      default: ChunkingStrategy.FIXED,
    },
  },
  required: ["text"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    doc_id: {
      type: "string",
      title: "Document ID",
      description: "The document ID (only emitted when provided in input)",
    },
    chunks: ChunkRecordArraySchema,
    text: {
      type: "array",
      items: { type: "string" },
      title: "Texts",
      description: "Chunk texts (for TextEmbeddingTask)",
    },
    count: {
      type: "number",
      title: "Count",
      description: "Number of chunks generated",
    },
  },
  required: ["chunks", "text", "count"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type TextChunkerTaskInput = {
  doc_id?: string | undefined;
  strategy?: "fixed" | "sentence" | "paragraph" | "semantic" | undefined;
  chunkSize?: number | undefined;
  chunkOverlap?: number | undefined;
  text: string;
};
export type TextChunkerTaskOutput = {
  doc_id?: string | undefined;
  text: string[];
  chunks: {
    [x: string]: unknown;
    leafNodeId?: string | undefined;
    summary?: string | undefined;
    entities?: { type: string; text: string; score: number }[] | undefined;
    parentSummaries?: string[] | undefined;
    sectionTitles?: string[] | undefined;
    doc_title?: string | undefined;
    text: string;
    doc_id: string;
    chunkId: string;
    nodePath: string[];
    depth: number;
  }[];
  count: number;
};
export type TextChunkerTaskConfig = TaskConfig<TextChunkerTaskInput>;

interface RawChunk {
  text: string;
  startChar: number;
  endChar: number;
}

function isSentencePunctuation(char: string): boolean {
  return char === "." || char === "!" || char === "?";
}

function isWhitespaceChar(char: string): boolean {
  return char.length === 1 && char.trim() === "";
}

/** Linear-time split on `/[.!?]+\s+/`-style boundaries (avoids ReDoS-prone regex). */
function splitSentences(text: string): { sentences: string[]; starts: number[] } {
  const sentences: string[] = [];
  const starts: number[] = [];
  let lastIndex = 0;
  let i = 0;

  while (i < text.length) {
    if (isSentencePunctuation(text[i]!)) {
      let punctEnd = i;
      while (punctEnd < text.length && isSentencePunctuation(text[punctEnd]!)) {
        punctEnd++;
      }
      let spaceEnd = punctEnd;
      while (spaceEnd < text.length && isWhitespaceChar(text[spaceEnd]!)) {
        spaceEnd++;
      }
      if (spaceEnd > punctEnd) {
        sentences.push(text.substring(lastIndex, spaceEnd));
        starts.push(lastIndex);
        lastIndex = spaceEnd;
        i = spaceEnd;
        continue;
      }
    }
    i++;
  }

  if (lastIndex < text.length) {
    sentences.push(text.substring(lastIndex));
    starts.push(lastIndex);
  }

  return { sentences, starts };
}

/**
 * Task for chunking plain text into smaller segments with configurable strategies.
 * Emits `ChunkRecord[]` so the output is interchangeable with HierarchicalChunkerTask
 * and can feed directly into TextEmbeddingTask → ChunkVectorUpsertTask.
 *
 * Deterministic: identical inputs produce identical `chunkId`s (no random UUIDs),
 * so this task is safe to mark cacheable.
 */
export class TextChunkerTask extends Task<
  TextChunkerTaskInput,
  TextChunkerTaskOutput,
  TextChunkerTaskConfig
> {
  public static override type = "TextChunkerTask";
  /** Pure-compute chunking task — no provider capability required. */
  public static readonly requires: readonly Capability[] = [] as const satisfies Capability[];
  public static override category = "Document";
  public static override title = "Text Chunker";
  public static override description =
    "Splits text into chunks using various strategies (fixed, sentence, paragraph)";
  public static override cacheable = true;

  public static override inputSchema(): DataPortSchema {
    return inputSchema as DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return outputSchema as DataPortSchema;
  }

  override async execute(
    input: TextChunkerTaskInput,
    context: IExecuteContext
  ): Promise<TextChunkerTaskOutput> {
    const { text, doc_id, chunkSize = 512, strategy = ChunkingStrategy.FIXED } = input;
    // Unset, the overlap is held below the chunk so a small chunk size alone is not
    // refused for a default the caller never chose.
    const chunkOverlap = input.chunkOverlap ?? Math.max(0, Math.min(50, chunkSize - 1));
    if (chunkOverlap >= chunkSize) {
      throw new TaskInvalidInputError(
        `${this.type}: chunkOverlap (${chunkOverlap}) must be smaller than chunkSize (${chunkSize}), ` +
          `or no chunk would advance past the one before it`
      );
    }

    let rawChunks: RawChunk[];
    switch (strategy) {
      case ChunkingStrategy.SENTENCE:
      case ChunkingStrategy.SEMANTIC:
        // Semantic is currently aliased to sentence; true semantic chunking is TODO.
        rawChunks = this.chunkBySentence(text, chunkSize, chunkOverlap);
        break;
      case ChunkingStrategy.PARAGRAPH:
        rawChunks = this.chunkByParagraph(text, chunkSize, chunkOverlap);
        break;
      case ChunkingStrategy.FIXED:
      default:
        rawChunks = this.chunkFixed(text, chunkSize, chunkOverlap);
        break;
    }

    const nodePath = doc_id ? [doc_id] : [];
    const chunks: ChunkRecord[] = rawChunks.map((raw, index) => ({
      chunkId: doc_id ? `${doc_id}:${index}` : `chunk:${index}:${raw.startChar}`,
      doc_id: doc_id ?? "",
      text: raw.text,
      nodePath,
      depth: nodePath.length,
      ...(doc_id ? { leafNodeId: doc_id } : {}),
      index,
      startChar: raw.startChar,
      endChar: raw.endChar,
    }));

    const output: TextChunkerTaskOutput = {
      chunks,
      text: chunks.map((c) => c.text),
      count: chunks.length,
    };
    if (doc_id) output.doc_id = doc_id;
    return output;
  }

  /** Fixed-size chunking with overlap */
  private chunkFixed(text: string, chunkSize: number, chunkOverlap: number): RawChunk[] {
    const chunks: RawChunk[] = [];
    let startChar = 0;

    while (startChar < text.length) {
      const endChar = Math.min(startChar + chunkSize, text.length);
      chunks.push({
        text: text.substring(startChar, endChar),
        startChar,
        endChar,
      });
      // Move forward by chunkSize - chunkOverlap, but at least 1 character to prevent infinite loop.
      startChar += Math.max(1, chunkSize - chunkOverlap);
    }

    return chunks;
  }

  /** Sentence-based chunking that respects sentence boundaries */
  private chunkBySentence(text: string, chunkSize: number, chunkOverlap: number): RawChunk[] {
    const { sentences, starts: sentenceStarts } = splitSentences(text);

    const chunks: RawChunk[] = [];
    let currentChunk = "";
    let currentStartChar = 0;

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const sentenceStart = sentenceStarts[i];

      if (currentChunk.length > 0 && currentChunk.length + sentence.length > chunkSize) {
        chunks.push({
          text: currentChunk.trim(),
          startChar: currentStartChar,
          endChar: currentStartChar + currentChunk.length,
        });

        if (chunkOverlap > 0) {
          let overlapText = "";
          let j = i - 1;
          while (j >= 0 && overlapText.length < chunkOverlap) {
            overlapText = sentences[j] + overlapText;
            j--;
          }
          currentChunk = overlapText + sentence;
          currentStartChar = sentenceStarts[Math.max(0, j + 1)];
        } else {
          currentChunk = sentence;
          currentStartChar = sentenceStart;
        }
      } else {
        if (currentChunk.length === 0) {
          currentStartChar = sentenceStart;
        }
        currentChunk += sentence;
      }
    }

    if (currentChunk.length > 0) {
      chunks.push({
        text: currentChunk.trim(),
        startChar: currentStartChar,
        endChar: currentStartChar + currentChunk.length,
      });
    }

    return chunks;
  }

  /** Paragraph-based chunking that respects paragraph boundaries */
  private chunkByParagraph(text: string, chunkSize: number, chunkOverlap: number): RawChunk[] {
    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
    const chunks: RawChunk[] = [];
    let currentChunk = "";
    let currentStartChar = 0;
    let charPosition = 0;

    for (let i = 0; i < paragraphs.length; i++) {
      const paragraph = paragraphs[i].trim();
      const paragraphStart = text.indexOf(paragraph, charPosition);
      charPosition = paragraphStart + paragraph.length;

      if (currentChunk.length > 0 && currentChunk.length + paragraph.length + 2 > chunkSize) {
        chunks.push({
          text: currentChunk.trim(),
          startChar: currentStartChar,
          endChar: currentStartChar + currentChunk.length,
        });

        if (chunkOverlap > 0 && i > 0) {
          let overlapText = "";
          let j = i - 1;
          while (j >= 0 && overlapText.length < chunkOverlap) {
            overlapText = paragraphs[j].trim() + "\n\n" + overlapText;
            j--;
          }
          currentChunk = overlapText + paragraph;
          currentStartChar = paragraphStart - overlapText.length;
        } else {
          currentChunk = paragraph;
          currentStartChar = paragraphStart;
        }
      } else {
        if (currentChunk.length === 0) {
          currentStartChar = paragraphStart;
          currentChunk = paragraph;
        } else {
          currentChunk += "\n\n" + paragraph;
        }
      }
    }

    if (currentChunk.length > 0) {
      chunks.push({
        text: currentChunk.trim(),
        startChar: currentStartChar,
        endChar: currentStartChar + currentChunk.length,
      });
    }

    return chunks;
  }
}

export const textChunker = (
  input: TextChunkerTaskInput,
  config?: TextChunkerTaskConfig,
  runConfig?: Partial<IRunConfig>
) => {
  return new TextChunkerTask(config).run(input, runConfig);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    textChunker: CreateWorkflow<TextChunkerTaskInput, TextChunkerTaskOutput, TextChunkerTaskConfig>;
  }
}

Workflow.prototype.textChunker = CreateWorkflow(TextChunkerTask);
