/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChunkSearchResult, KnowledgeBase } from "@workglow/knowledge-base";
import { chunkText, TypeKnowledgeBase } from "@workglow/knowledge-base";
import type {
  CachePolicy,
  IExecuteContext,
  IRunConfig,
  TaskConfig,
  TaskEntitlements,
} from "@workglow/task-graph";
import { CreateWorkflow, Entitlements, Task, Workflow } from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import type { Capability } from "../capability/Capabilities";

const inputSchema = {
  type: "object",
  properties: {
    knowledgeBase: TypeKnowledgeBase({
      title: "Knowledge Base",
      description: "Knowledge base to search.",
    }),
    query: {
      type: "string",
      title: "Query",
      description: "Search query text.",
    },
    topK: {
      type: "number",
      title: "Top K",
      description: "Number of top results to return.",
      minimum: 1,
      default: 5,
    },
    filter: {
      type: "object",
      title: "Metadata Filter",
      description: "Filter results by chunk metadata fields.",
    },
    scoreThreshold: {
      type: "number",
      title: "Score Threshold",
      description:
        "Minimum score to include a result. Honored by similarity and hybrid search modes; ignored by the strategy in rerank mode (cross-encoder logits aren't comparable to cosine/RRF scores). Not constrained to a range — some embedding models (un-normalized dot product) produce scores outside [0, 1].",
    },
  },
  required: ["knowledgeBase", "query"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        title: "Chunk Search Result",
        description: "A single chunk match with score and metadata",
      },
      title: "Results",
      description: "Matching chunks in score-desc order",
    },
    chunks: {
      type: "array",
      items: { type: "string" },
      title: "Chunks",
      description: "The chunk text content, parallel to `results`",
    },
    chunk_ids: {
      type: "array",
      items: { type: "string" },
      title: "Chunk IDs",
      description: "The chunk ids, parallel to `results`",
    },
    scores: {
      type: "array",
      items: { type: "number" },
      title: "Scores",
      description: "Scores parallel to `results`",
    },
    count: {
      type: "number",
      title: "Count",
      description: "Number of results returned",
    },
  },
  required: ["results", "chunks", "chunk_ids", "scores", "count"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type KbSearchTaskInput = {
  filter?: { [x: string]: unknown } | undefined;
  topK?: number | undefined;
  scoreThreshold?: number | undefined;
  query: string;
  knowledgeBase: unknown;
};
export type KbSearchTaskOutput = {
  readonly results: ChunkSearchResult[];
  readonly chunks: string[];
  readonly chunk_ids: string[];
  readonly scores: number[];
  readonly count: number;
};
export type KbSearchTaskConfig = TaskConfig<KbSearchTaskInput>;

/**
 * High-level KB search task. Delegates to `kb.search(query, options)`; the
 * KB and its installed strategy decide everything else (embedding model,
 * retrieval mode, rerank). No model or kind input here — that's the
 * point of moving the config onto the KB itself.
 */
export class KbSearchTask extends Task<KbSearchTaskInput, KbSearchTaskOutput, KbSearchTaskConfig> {
  public static override type = "KbSearchTask";
  /**
   * Pure-compute task (vector similarity query against an in-process
   * KnowledgeBase) — no AI provider dispatch. `requires: []` opts out of
   * capability gating; the audit test in `index.test.ts` only inspects the
   * field shape.
   */
  public static readonly requires: readonly Capability[] = [] as const satisfies Capability[];
  public static override category = "RAG";
  public static override title = "KB Search";
  public static override description =
    "Search a knowledge base. The KB owns its embedding/reranker models and search mode internally.";
  /**
   * Not cached: the result reflects the knowledge base as it is now, and the cache key
   * is only the input — an upsert or delete between runs would be answered as it was.
   */
  public static override cachePolicy: CachePolicy = { kind: "none" };

  /** Declared so a host can ask what this reaches before running it. */
  public static override entitlements(): TaskEntitlements {
    return {
      entitlements: [
        { id: Entitlements.STORAGE_READ, reason: "Reads chunks from a knowledge base" },
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
    input: KbSearchTaskInput,
    context: IExecuteContext
  ): Promise<KbSearchTaskOutput> {
    const { knowledgeBase, query, topK = 5, filter, scoreThreshold } = input;
    const kb = knowledgeBase as KnowledgeBase;
    const results = await kb.search(
      query,
      { topK, filter, scoreThreshold },
      {
        signal: context.signal,
        resourceScope: context.resourceScope,
        registry: context.registry,
      }
    );
    return {
      results,
      chunks: results.map(chunkText),
      chunk_ids: results.map((r) => r.chunk_id),
      scores: results.map((r) => r.score),
      count: results.length,
    };
  }
}

export const kbSearch = (
  input: KbSearchTaskInput,
  config?: KbSearchTaskConfig,
  runConfig?: Partial<IRunConfig>
) => {
  return new KbSearchTask(config).run(input, runConfig);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    kbSearch: CreateWorkflow<KbSearchTaskInput, KbSearchTaskOutput, KbSearchTaskConfig>;
  }
}

Workflow.prototype.kbSearch = CreateWorkflow(KbSearchTask);
