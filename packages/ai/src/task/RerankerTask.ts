/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { CreateWorkflow, Task, Workflow } from "@workglow/task-graph";

import type { IExecuteContext, IRunConfig, TaskConfig } from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import type { Capability } from "../capability/Capabilities";

const inputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      title: "Query",
      description: "The query to rerank results against",
    },
    chunks: {
      type: "array",
      items: { type: "string" },
      title: "Text Chunks",
      description: "Retrieved text chunks to rerank",
    },
    scores: {
      type: "array",
      items: { type: "number" },
      title: "Initial Scores",
      description: "Initial retrieval scores (optional)",
    },
    metadata: {
      type: "array",
      items: {
        type: "object",
        title: "Metadata",
        description: "Metadata for each chunk",
      },
      title: "Metadata",
      description: "Metadata for each chunk (optional)",
    },
    topK: {
      type: "number",
      title: "Top K",
      description: "Number of top results to return after reranking",
      minimum: 1,
    },
    method: {
      type: "string",
      enum: ["reciprocal-rank-fusion", "simple"],
      title: "Reranking Method",
      description: "Heuristic reranking method",
      default: "simple",
    },
  },
  required: ["query", "chunks"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    chunks: {
      type: "array",
      items: { type: "string" },
      title: "Reranked Chunks",
      description: "Chunks reordered by relevance",
    },
    scores: {
      type: "array",
      items: { type: "number" },
      title: "Reranked Scores",
      description: "New relevance scores",
    },
    metadata: {
      type: "array",
      items: {
        type: "object",
        title: "Metadata",
        description: "Metadata for each chunk",
      },
      title: "Metadata",
      description: "Metadata for reranked chunks",
    },
    originalIndices: {
      type: "array",
      items: { type: "number" },
      title: "Original Indices",
      description: "Original indices of reranked chunks",
    },
    count: {
      type: "number",
      title: "Count",
      description: "Number of results returned",
    },
  },
  required: ["chunks", "scores", "originalIndices", "count"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type RerankerTaskInput = {
  metadata?: { [x: string]: unknown }[] | undefined;
  scores?: number[] | undefined;
  topK?: number | undefined;
  method?: "reciprocal-rank-fusion" | "simple" | undefined;
  chunks: string[];
  query: string;
};
export type RerankerTaskOutput = {
  metadata?: { [x: string]: unknown }[] | undefined;
  chunks: string[];
  count: number;
  scores: number[];
  originalIndices: number[];
};
export type RerankerTaskConfig = TaskConfig<RerankerTaskInput>;

interface RankedItem {
  chunk: string;
  score: number;
  metadata?: any;
  originalIndex: number;
}

/**
 * Escape every regex metacharacter so a query token can be safely embedded
 * in `new RegExp(token, "gi")`. Without this, user input like `foo(`,
 * `\\`, `*abc`, or `[` causes `new RegExp` to throw `SyntaxError: Invalid
 * regular expression`, surfacing a 500-shaped failure in `simpleRerank`
 * rather than treating the token as a literal.
 *
 * The pattern matches the canonical TC39 proposal for `RegExp.escape` and
 * the long-standing MDN snippet — `-` is included so the helper is safe to
 * paste inside a character class as well.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/**
 * Rerank retrieved chunks to improve relevance using in-process heuristics.
 * Supports `simple` (keyword overlap + position) and `reciprocal-rank-fusion`.
 * Note: a `cross-encoder` method will be added when a real cross-encoder
 * task exists; until then, use a dedicated model task upstream.
 */
export class RerankerTask extends Task<RerankerTaskInput, RerankerTaskOutput, RerankerTaskConfig> {
  public static override type = "RerankerTask";
  /** Heuristic: calls no model, so it requires no model capability. */
  public static readonly requires: readonly Capability[] = [] as const satisfies Capability[];
  public static override category = "RAG";
  public static override title = "Reranker";
  public static override description = "Rerank retrieved chunks using in-process heuristics";
  public static override cacheable = true;

  public static override inputSchema(): DataPortSchema {
    return inputSchema as DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return outputSchema as DataPortSchema;
  }

  override async execute(
    input: RerankerTaskInput,
    _context: IExecuteContext
  ): Promise<RerankerTaskOutput> {
    const { query, chunks, scores = [], metadata = [], topK, method = "simple" } = input;

    let rankedItems: RankedItem[];
    switch (method) {
      case "reciprocal-rank-fusion":
        rankedItems = this.reciprocalRankFusion(query, chunks, scores, metadata);
        break;
      case "simple":
      default:
        rankedItems = this.simpleRerank(query, chunks, scores, metadata);
        break;
    }

    if (topK && topK < rankedItems.length) {
      rankedItems = rankedItems.slice(0, topK);
    }

    return {
      chunks: rankedItems.map((item) => item.chunk),
      scores: rankedItems.map((item) => item.score),
      metadata: rankedItems.map((item) => item.metadata),
      originalIndices: rankedItems.map((item) => item.originalIndex),
      count: rankedItems.length,
    };
  }

  /** Simple heuristic reranking: keyword overlap + exact match bonus - position penalty */
  private simpleRerank(
    query: string,
    chunks: string[],
    scores: number[],
    metadata: any[]
  ): RankedItem[] {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 0);
    const hasQueryWords = queryWords.length > 0;

    const items: RankedItem[] = chunks.map((chunk, index) => {
      const chunkLower = chunk.toLowerCase();
      const initialScore = scores[index] || 0;

      const keywordScore = this.keywordMatchCount(queryWords, chunkLower);

      const exactMatchBonus = hasQueryWords && chunkLower.includes(queryLower) ? 0.5 : 0;
      const normalizedKeywordScore = hasQueryWords
        ? Math.min(keywordScore / (queryWords.length * 3), 1)
        : 0;
      const positionPenalty = Math.log(index + 1) / 10;

      const combinedScore =
        initialScore * 0.4 + normalizedKeywordScore * 0.4 + exactMatchBonus * 0.2 - positionPenalty;

      return { chunk, score: combinedScore, metadata: metadata[index], originalIndex: index };
    });

    items.sort((a, b) => b.score - a.score);
    return items;
  }

  /**
   * Count regex-safe keyword-token matches of `queryWords` within a chunk
   * (already lower-cased). Shared by {@link simpleRerank} and
   * {@link reciprocalRankFusion}.
   */
  private keywordMatchCount(queryWords: string[], chunkLower: string): number {
    let keywordScore = 0;
    for (const word of queryWords) {
      // Skip pure-whitespace / empty tokens (defensive: the split + filter at
      // the call site should already exclude them, but keep the contract local).
      if (word.length === 0 || /^\s+$/.test(word)) continue;
      // Escape every regex metacharacter so user input like `foo(`, `\\`,
      // `*abc`, or `[` is treated as a literal token rather than being parsed
      // as a regex (which would throw `SyntaxError`).
      const regex = new RegExp(escapeRegExp(word), "gi");
      const matches = chunkLower.match(regex);
      if (matches) keywordScore += matches.length;
    }
    return keywordScore;
  }

  /**
   * Reciprocal Rank Fusion. Fuses two rankings of the same chunks — the
   * retrieval ranking (the provided initial `scores`, or the input order when
   * no scores are given) and a lexical keyword-overlap ranking derived from the
   * `query` — via `RRF(d) = Σ 1 / (k + rank_r(d))`. This is the point of RRF:
   * a chunk ranked highly by both similarity and keyword overlap floats to the
   * top even if neither signal alone put it first. Unlike a single-signal sort,
   * it actually reads `scores` and `query`.
   */
  private reciprocalRankFusion(
    query: string,
    chunks: string[],
    scores: number[],
    metadata: any[]
  ): RankedItem[] {
    const k = 60;
    const n = chunks.length;
    if (n === 0) return [];

    // Ranking A — retrieval order. Prefer the provided initial scores; fall
    // back to the input order (already retrieval order) when none are given.
    const scoreOrder = chunks.map((_, index) => index);
    if (scores.some((s) => typeof s === "number")) {
      scoreOrder.sort((a, b) => (scores[b] ?? -Infinity) - (scores[a] ?? -Infinity));
    }
    const scoreRank = new Array<number>(n);
    scoreOrder.forEach((originalIndex, rank) => (scoreRank[originalIndex] = rank));

    // Ranking B — lexical keyword overlap with the query (plus an exact-phrase
    // nudge), so RRF fuses a keyword signal with the retrieval signal.
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 0);
    const keywordScores = chunks.map((chunk) => {
      const chunkLower = chunk.toLowerCase();
      const base = this.keywordMatchCount(queryWords, chunkLower);
      return base + (queryWords.length > 0 && chunkLower.includes(queryLower) ? 0.5 : 0);
    });
    const keywordOrder = chunks.map((_, index) => index);
    keywordOrder.sort((a, b) => keywordScores[b] - keywordScores[a]);
    const keywordRank = new Array<number>(n);
    keywordOrder.forEach((originalIndex, rank) => (keywordRank[originalIndex] = rank));

    const items: RankedItem[] = chunks.map((chunk, index) => ({
      chunk,
      score: 1 / (k + scoreRank[index] + 1) + 1 / (k + keywordRank[index] + 1),
      metadata: metadata[index],
      originalIndex: index,
    }));
    items.sort((a, b) => b.score - a.score);
    return items;
  }
}

export const reranker = (
  input: RerankerTaskInput,
  config?: RerankerTaskConfig,
  runConfig?: Partial<IRunConfig>
) => {
  return new RerankerTask(config).run(input, runConfig);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    reranker: CreateWorkflow<RerankerTaskInput, RerankerTaskOutput, RerankerTaskConfig>;
  }
}

Workflow.prototype.reranker = CreateWorkflow(RerankerTask);
