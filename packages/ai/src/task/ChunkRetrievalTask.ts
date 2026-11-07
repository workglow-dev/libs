/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChunkRecord, ChunkSearchResult, KnowledgeBase } from "@workglow/knowledge-base";
import { TypeKnowledgeBase } from "@workglow/knowledge-base";
import type {
  CachePolicy,
  IExecuteContext,
  IRunConfig,
  TaskConfig,
  TaskEntitlements,
} from "@workglow/task-graph";
import { CreateWorkflow, Entitlements, Task, Workflow } from "@workglow/task-graph";
import type { DataPortSchema, TypedArray } from "@workglow/util/schema";
import { isTypedArray, TypedArraySchema } from "@workglow/util/schema";
import type { Capability } from "../capability/Capabilities";
import type { ModelConfig } from "../model/ModelSchema";
import { TypeModel } from "./base/AiTaskSchemas";
import { TextEmbeddingTask } from "./TextEmbeddingTask";

export const ChunkRetrievalInputSchema = {
  type: "object",
  properties: {
    knowledgeBase: TypeKnowledgeBase({
      title: "Knowledge Base",
      description: "The knowledge base instance to search in",
    }),
    query: {
      oneOf: [
        { type: "string" },
        TypedArraySchema({
          title: "Query Vector",
          description: "Pre-computed query vector",
        }),
      ],
      title: "Query",
      description: "Query string (requires `model`) or pre-computed query vector",
    },
    model: TypeModel("model:TextEmbeddingTask", {
      title: "Model",
      description:
        "Text embedding model to use for query embedding (required when query is a string)",
    }),
    method: {
      type: "string",
      enum: ["similarity", "hybrid"],
      title: "Retrieval Method",
      description:
        "Retrieval strategy: 'similarity' (vector only, scores are cosine similarity in [0,1]) " +
        "or 'hybrid' (vector + full-text fused via Reciprocal Rank Fusion; scores are RRF " +
        "fusion scores, NOT comparable to cosine similarity).",
      default: "similarity",
    },
    topK: {
      type: "number",
      title: "Top K",
      description: "Number of top results to return",
      minimum: 1,
      default: 5,
    },
    filter: {
      type: "object",
      title: "Metadata Filter",
      description: "Filter results by metadata fields",
    },
    scoreThreshold: {
      type: "number",
      title: "Score Threshold",
      description:
        "Minimum cosine similarity score threshold (0-1). Applies only to method='similarity'; " +
        "ignored for method='hybrid' because RRF fusion scores are not comparable to cosine " +
        "similarity. Use topK to size hybrid results instead.",
      minimum: 0,
      maximum: 1,
      default: 0,
    },
    vectorWeight: {
      type: "number",
      title: "Vector Weight",
      description:
        "For hybrid method: weight for vector similarity (0-1), remainder goes to text relevance",
      minimum: 0,
      maximum: 1,
      default: 0.7,
    },
    returnVectors: {
      type: "boolean",
      title: "Return Vectors",
      description: "Whether to return vector embeddings in results",
      default: false,
    },
  },
  required: ["knowledgeBase", "query"],
  if: {
    properties: {
      query: { type: "string" },
    },
  },
  then: {
    required: ["knowledgeBase", "query", "model"],
  },
  else: {},
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    chunks: {
      type: "array",
      items: { type: "string" },
      title: "Text Chunks",
      description: "Retrieved text chunks",
    },
    chunk_ids: {
      type: "array",
      items: { type: "string" },
      title: "IDs",
      description: "IDs of retrieved chunks",
    },
    metadata: {
      type: "array",
      items: {
        type: "object",
        title: "Metadata",
        description: "Metadata of retrieved chunk",
      },
      title: "Metadata",
      description: "Metadata of retrieved chunks",
    },
    scores: {
      type: "array",
      items: { type: "number" },
      title: "Scores",
      description:
        "Per-result scores. For method='similarity', these are cosine similarity scores in " +
        "[0,1]. For method='hybrid', these are Reciprocal Rank Fusion scores — small positive " +
        "numbers (typically <0.05) that rank results but do not correspond to a similarity.",
    },
    scoreType: {
      type: "string",
      enum: ["cosine", "bm25", "rrf", "rerank"],
      title: "Score Type",
      description:
        "Discriminator naming the scorer used for `scores`: 'cosine' for similarity search " +
        "and for hybrid fallback when the text query is empty/whitespace; 'rrf' for hybrid " +
        "fusion. ('bm25' is reserved for direct text search and is not produced by this task. " +
        "'rerank' is produced by the standard KB strategy after cross-encoder reranking and " +
        "is not produced by this task either.)",
    },
    vectors: {
      type: "array",
      items: TypedArraySchema({
        title: "Vector",
        description: "Vector embedding",
      }),
      title: "Vectors",
      description: "Vector embeddings (if returnVectors is true)",
    },
    count: {
      type: "number",
      title: "Count",
      description: "Number of results returned",
    },
    query: {
      oneOf: [
        { type: "string" },
        TypedArraySchema({
          title: "Query Vector",
          description: "Pre-computed query vector",
        }),
      ],
      title: "Query",
      description: "The query used for retrieval (pass-through)",
    },
  },
  required: ["chunks", "chunk_ids", "metadata", "scores", "scoreType", "count", "query"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

/**
 * Intentionally tighter than `FromSchema`'s resolution: encodes the schema's
 * `if/then/else` (when `query: string`, `model` is required) which
 * `json-schema-to-ts` ignores. The nightly drift type-test pins this
 * divergence by asserting one-way assignability rather than equality.
 */
export type ChunkRetrievalTaskInput =
  | {
      filter?: { [x: string]: unknown } | undefined;
      topK?: number | undefined;
      method?: "similarity" | "hybrid" | undefined;
      scoreThreshold?: number | undefined;
      vectorWeight?: number | undefined;
      returnVectors?: boolean | undefined;
      model: string | ModelConfig;
      query: string;
      knowledgeBase: unknown;
    }
  | {
      model?: string | ModelConfig | undefined;
      filter?: { [x: string]: unknown } | undefined;
      topK?: number | undefined;
      method?: "similarity" | "hybrid" | undefined;
      scoreThreshold?: number | undefined;
      vectorWeight?: number | undefined;
      returnVectors?: boolean | undefined;
      query: TypedArray;
      knowledgeBase: unknown;
    };
export type ChunkRetrievalTaskOutput = {
  vectors?: TypedArray[] | undefined;
  metadata: { [x: string]: unknown }[];
  chunks: string[];
  count: number;
  query: string | TypedArray;
  scores: number[];
  chunk_ids: string[];
  scoreType: "cosine" | "bm25" | "rrf" | "rerank";
};
export type ChunkRetrievalTaskConfig = TaskConfig<ChunkRetrievalTaskInput>;

/**
 * End-to-end retrieval task that combines query embedding (if needed), vector
 * search, and optional hybrid full-text search in a single step.
 */
export class ChunkRetrievalTask extends Task<
  ChunkRetrievalTaskInput,
  ChunkRetrievalTaskOutput,
  ChunkRetrievalTaskConfig
> {
  public static override type = "ChunkRetrievalTask";
  /** Pure-compute retrieval task — uses storage, not a provider capability. */
  public static readonly requires: readonly Capability[] = [] as const satisfies Capability[];
  public static override category = "RAG";
  public static override title = "Chunk Retrieval";
  public static override description =
    "End-to-end retrieval: embed query (if string) and search the knowledge base. Supports similarity and hybrid methods.";
  /**
   * Not cached: the result reflects the knowledge base as it is now, and the cache key
   * is only the input — an upsert or delete between runs would be answered as it was.
   */
  public static override cachePolicy: CachePolicy = { kind: "none" };

  /** Declared so a host can ask what this reaches before running it. */
  public static override entitlements(): TaskEntitlements {
    return {
      entitlements: [
        { id: Entitlements.STORAGE_READ, reason: "Searches chunks in a knowledge base" },
        {
          id: Entitlements.AI_INFERENCE,
          reason: "Embeds the query through an owned embedding task",
        },
      ],
    };
  }

  public static override inputSchema(): DataPortSchema {
    return ChunkRetrievalInputSchema as DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return outputSchema as DataPortSchema;
  }

  override async execute(
    input: ChunkRetrievalTaskInput,
    context: IExecuteContext
  ): Promise<ChunkRetrievalTaskOutput> {
    const {
      knowledgeBase,
      query,
      topK = 5,
      filter,
      model,
      method = "similarity",
      vectorWeight = 0.7,
      scoreThreshold = 0,
      returnVectors = false,
    } = input;

    const kb = knowledgeBase as KnowledgeBase;

    const queryIsString = typeof query === "string";

    if (method === "hybrid" && !queryIsString) {
      throw new Error(
        "Hybrid retrieval requires a string query (it will be embedded and used for full-text search)."
      );
    }
    if (method === "hybrid" && !kb.supportsHybridSearch()) {
      throw new Error(
        "Hybrid retrieval requires a text index installed on the knowledge base. " +
          "Install one via `kb.installTextIndex(new BM25Index())` or pass " +
          "`textIndex` to `createKnowledgeBase`. Otherwise use method: 'similarity'."
      );
    }

    // Resolve the query to a single vector (+ original text, for hybrid mode).
    let queryVector: TypedArray;
    let queryText: string | undefined;

    if (queryIsString) {
      if (!model) {
        throw new Error(
          "Model is required when query is a string. Please provide a model with format 'model:TextEmbeddingTask'."
        );
      }
      queryText = query;
      const embeddingTask = context.own(new TextEmbeddingTask());
      const embeddingResult = await embeddingTask.run({ text: query, model });
      const vec = embeddingResult.vector;
      queryVector = Array.isArray(vec) ? vec[0] : vec;
    } else if (isTypedArray(query)) {
      queryVector = query;
    } else {
      throw new Error("Query must be a string or TypedArray");
    }

    const searchVector =
      queryVector instanceof Float32Array ? queryVector : new Float32Array(queryVector);

    const results: ChunkSearchResult[] =
      method === "hybrid"
        ? await kb.hybridSearch(searchVector, {
            textQuery: queryText!,
            topK,
            filter,
            vectorWeight,
          })
        : await kb.similaritySearch(searchVector, {
            topK,
            filter,
            scoreThreshold,
          });

    const chunks = results.map((r) => {
      const meta = r.metadata as ChunkRecord;
      return meta.text || JSON.stringify(meta);
    });

    // The KB tags every result with the same scoreType; the empty-textQuery
    // fallback inside hybridSearch flips this from "rrf" to "cosine", and we
    // want to surface that to callers even when the result set is empty.
    const hybridFallsBackToCosine =
      method === "hybrid" && (queryText === undefined || queryText.trim().length === 0);
    // `ChunkRetrievalTask` itself only produces cosine or RRF scores; it
    // can't emit "bm25" (no text-only path) or "rerank" (that comes from
    // a downstream reranker, not this task). The output-schema enum
    // includes them so the field is consistent with the canonical
    // `ScoreType` union, but they won't appear in `defaultScoreType`.
    const defaultScoreType: "cosine" | "rrf" =
      method === "hybrid" && !hybridFallsBackToCosine ? "rrf" : "cosine";
    const scoreType: "cosine" | "bm25" | "rrf" | "rerank" =
      results.length > 0 ? (results[0].scoreType ?? defaultScoreType) : defaultScoreType;

    const output: ChunkRetrievalTaskOutput = {
      chunks,
      chunk_ids: results.map((r) => r.chunk_id),
      metadata: results.map((r) => r.metadata),
      scores: results.map((r) => r.score),
      scoreType,
      count: results.length,
      query,
    };

    if (returnVectors) {
      output.vectors = results.map((r) => r.vector);
    }

    return output;
  }
}

export const chunkRetrieval = (
  input: ChunkRetrievalTaskInput,
  config?: ChunkRetrievalTaskConfig,
  runConfig?: Partial<IRunConfig>
) => {
  return new ChunkRetrievalTask(config).run(input, runConfig);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    chunkRetrieval: CreateWorkflow<
      ChunkRetrievalTaskInput,
      ChunkRetrievalTaskOutput,
      ChunkRetrievalTaskConfig
    >;
  }
}

Workflow.prototype.chunkRetrieval = CreateWorkflow(ChunkRetrievalTask);
