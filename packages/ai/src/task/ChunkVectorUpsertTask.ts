/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChunkRecord, KnowledgeBase } from "@workglow/knowledge-base";
import { ChunkRecordArraySchema, TypeKnowledgeBase } from "@workglow/knowledge-base";
import type {
  CachePolicy,
  IExecuteContext,
  IRunConfig,
  TaskConfig,
  TaskEntitlements,
} from "@workglow/task-graph";
import {
  CreateWorkflow,
  Entitlements,
  Task,
  TaskInvalidInputError,
  Workflow,
} from "@workglow/task-graph";
import type { DataPortSchema, TypedArray } from "@workglow/util/schema";
import { TypedArraySchema } from "@workglow/util/schema";
import type { Capability } from "../capability/Capabilities";
import { TypeSingleOrArray } from "./base/AiTaskSchemas";

const inputSchema = {
  type: "object",
  properties: {
    knowledgeBase: TypeKnowledgeBase({
      title: "Knowledge Base",
      description: "The knowledge base instance to store vectors in",
    }),
    chunks: ChunkRecordArraySchema,
    vector: TypeSingleOrArray(
      TypedArraySchema({
        title: "Vectors",
        description: "The vector embeddings, aligned 1:1 with chunks",
      })
    ),
    doc_title: {
      type: "string",
      title: "Document Title",
      description: "Optional human-readable title stamped onto each chunk's metadata",
    },
  },
  required: ["knowledgeBase", "chunks", "vector"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    count: {
      type: "number",
      title: "Count",
      description: "Number of vectors upserted",
    },
    doc_id: {
      type: "string",
      title: "Document ID",
      description: "The document ID (read from the first chunk)",
    },
    chunk_ids: {
      type: "array",
      items: { type: "string" },
      title: "Chunk IDs",
      description: "Chunk IDs of upserted vectors",
    },
  },
  required: ["count", "doc_id", "chunk_ids"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type VectorStoreUpsertTaskInput = {
  doc_title?: string | undefined;
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
  vector: TypedArray | TypedArray[];
  knowledgeBase: unknown;
};
export type VectorStoreUpsertTaskOutput = { doc_id: string; count: number; chunk_ids: string[] };
export type ChunkVectorUpsertTaskConfig = TaskConfig<VectorStoreUpsertTaskInput>;

/**
 * Upsert chunks + their embeddings into a knowledge base in a single step.
 * Consumes the output of `HierarchicalChunkerTask` (chunks) and
 * `TextEmbeddingTask` (vector) directly — no intermediate transform task needed.
 */
export class ChunkVectorUpsertTask extends Task<
  VectorStoreUpsertTaskInput,
  VectorStoreUpsertTaskOutput,
  ChunkVectorUpsertTaskConfig
> {
  public static override type = "ChunkVectorUpsertTask";
  /** Pure-compute upsert task — uses storage, not a provider capability. */
  public static readonly requires: readonly Capability[] = [] as const satisfies Capability[];
  public static override category = "Document";
  public static override title = "Add to Vector Store";
  public static override description =
    "Store chunks + their embeddings in a knowledge base (1:1 aligned)";
  public static override cachePolicy: CachePolicy = { kind: "none" }; // Has side effects

  /** Declared so a host can ask what this reaches before running it. */
  public static override entitlements(): TaskEntitlements {
    return {
      entitlements: [
        { id: Entitlements.STORAGE_WRITE, reason: "Writes chunk vectors into a knowledge base" },
      ],
    };
  }

  public static override inputSchema(): DataPortSchema {
    return inputSchema as DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return outputSchema as DataPortSchema;
  }

  override async execute(
    input: VectorStoreUpsertTaskInput,
    context: IExecuteContext
  ): Promise<VectorStoreUpsertTaskOutput> {
    const { knowledgeBase, chunks, vector, doc_title } = input;

    const chunkArray = chunks as ChunkRecord[];
    const vectorArray: TypedArray[] = Array.isArray(vector) ? vector : [vector];

    if (chunkArray.length !== vectorArray.length) {
      throw new TaskInvalidInputError(
        `Mismatch: ${chunkArray.length} chunks but ${vectorArray.length} vectors — they must be 1:1 aligned`
      );
    }

    if (chunkArray.length === 0) {
      return { doc_id: "", chunk_ids: [], count: 0 };
    }

    const kb = knowledgeBase as KnowledgeBase;
    const doc_id = chunkArray[0].doc_id;

    // Upsert is scoped to a single document — callers must pass chunks from one
    // doc. Mixing doc_ids would upsert rows under multiple docs while returning
    // a misleading single doc_id, so we reject it up front.
    for (let i = 1; i < chunkArray.length; i++) {
      if (chunkArray[i].doc_id !== doc_id) {
        throw new TaskInvalidInputError(
          `ChunkVectorUpsertTask expects all chunks to share one doc_id, but chunk[${i}] has doc_id=${JSON.stringify(chunkArray[i].doc_id)} (expected ${JSON.stringify(doc_id)}).`
        );
      }
    }

    await context.updateProgress(1, "Upserting vectors");

    const entities = chunkArray.map((chunk, i) => {
      const leafNodeId = chunk.leafNodeId ?? chunk.nodePath[chunk.nodePath.length - 1] ?? undefined;
      const metadata: ChunkRecord = {
        ...chunk,
        ...(leafNodeId !== undefined ? { leafNodeId } : {}),
        ...(doc_title ? { doc_title } : {}),
      };
      return {
        doc_id: chunk.doc_id,
        vector: vectorArray[i],
        metadata,
      };
    });

    const results = await kb.upsertChunksBulk(entities);
    const chunk_ids = results.map((r) => r.chunk_id);

    return {
      doc_id,
      chunk_ids,
      count: chunk_ids.length,
    };
  }
}

export const chunkVectorUpsert = (
  input: VectorStoreUpsertTaskInput,
  config?: ChunkVectorUpsertTaskConfig,
  runConfig?: Partial<IRunConfig>
) => {
  return new ChunkVectorUpsertTask(config).run(input, runConfig);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    chunkVectorUpsert: CreateWorkflow<
      VectorStoreUpsertTaskInput,
      VectorStoreUpsertTaskOutput,
      ChunkVectorUpsertTaskConfig
    >;
  }
}

Workflow.prototype.chunkVectorUpsert = CreateWorkflow(ChunkVectorUpsertTask);
