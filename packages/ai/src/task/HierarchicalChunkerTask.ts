/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ChunkRecordSchema,
  estimateTokens,
  getChildren,
  hasChildren,
  NodeKind,
} from "@workglow/knowledge-base";

import type {
  ChunkRecord,
  DocumentNode,
  DocumentRootNode,
  SectionNode,
  TokenBudget,
} from "@workglow/knowledge-base";
import type { IExecuteContext, IRunConfig, TaskConfig } from "@workglow/task-graph";
import { CreateWorkflow, Task, TaskInvalidInputError, Workflow } from "@workglow/task-graph";
import { uuid4 } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import type { Capability } from "../capability/Capabilities";
import type { ModelConfig } from "../model/ModelSchema";
import { CountTokensTask } from "./CountTokensTask";
import { TypeModel } from "./base/AiTaskSchemas";

const modelSchema = TypeModel("model", {
  title: "Model",
  description: "Model to use for token counting",
});

const inputSchema = {
  type: "object",
  properties: {
    doc_id: {
      type: "string",
      title: "Document ID",
      description: "The ID of the document",
    },
    documentTree: {
      type: "object",
      additionalProperties: true,
      title: "Document Tree",
      description: "The hierarchical document tree to chunk",
    },
    maxTokens: {
      type: "number",
      title: "Max Tokens",
      description: "Maximum tokens per chunk",
      minimum: 50,
      default: 512,
    },
    overlap: {
      type: "number",
      title: "Overlap",
      description: "Overlap in tokens between chunks",
      minimum: 0,
      default: 50,
    },
    reservedTokens: {
      type: "number",
      title: "Reserved Tokens",
      description: "Reserved tokens for metadata/wrappers",
      minimum: 0,
      default: 10,
    },
    strategy: {
      type: "string",
      enum: ["hierarchical", "flat", "sentence"],
      title: "Chunking Strategy",
      description: "Strategy for chunking",
      default: "hierarchical",
    },
    model: modelSchema,
  },
  required: ["doc_id", "documentTree"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    doc_id: {
      type: "string",
      title: "Document ID",
      description: "The document ID (passed through)",
    },
    chunks: {
      type: "array",
      items: ChunkRecordSchema(),
      title: "Chunks",
      description: "Array of chunk records",
    },
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
  required: ["doc_id", "chunks", "text", "count"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type HierarchicalChunkerTaskInput = Omit<
  {
    model?: string | ModelConfig | undefined;
    maxTokens?: number | undefined;
    overlap?: number | undefined;
    reservedTokens?: number | undefined;
    strategy?: "flat" | "hierarchical" | "sentence" | undefined;
    doc_id: string;
    documentTree: { [x: string]: unknown };
  },
  "documentTree"
> & { documentTree: DocumentRootNode };
export type HierarchicalChunkerTaskOutput = {
  text: string[];
  doc_id: string;
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
export type HierarchicalChunkerTaskConfig = TaskConfig<HierarchicalChunkerTaskInput>;

/**
 * Task for hierarchical chunking that respects token budgets and document structure.
 * Pass a `model` in the input to use {@link CountTokensTask} for accurate token
 * counting; when omitted, the task falls back to the character-based estimate
 * provided by {@link estimateTokens}.
 */
export class HierarchicalChunkerTask extends Task<
  HierarchicalChunkerTaskInput,
  HierarchicalChunkerTaskOutput,
  HierarchicalChunkerTaskConfig
> {
  public static override type = "HierarchicalChunkerTask";
  /** Pure-compute chunking task — no provider capability required. */
  public static readonly requires: readonly Capability[] = [] as const satisfies Capability[];
  public static override category = "Document";
  public static override title = "Hierarchical Chunker";
  public static override description = "Chunk documents hierarchically respecting token budgets";
  public static override cacheable = true;

  public static override inputSchema(): DataPortSchema {
    return inputSchema as DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return outputSchema as DataPortSchema;
  }

  override async execute(
    input: HierarchicalChunkerTaskInput,
    context: IExecuteContext
  ): Promise<HierarchicalChunkerTaskOutput> {
    const {
      doc_id,
      documentTree,
      maxTokens = 512,
      overlap = 50,
      reservedTokens = 10,
      strategy = "hierarchical",
    } = input;

    if (!doc_id) {
      throw new TaskInvalidInputError("doc_id is required");
    }
    if (!documentTree) {
      throw new TaskInvalidInputError("documentTree is required");
    }

    const root = documentTree as DocumentNode;
    const tokenBudget: TokenBudget = {
      maxTokensPerChunk: maxTokens,
      overlapTokens: overlap,
      reservedTokens,
    };

    let countFn: (text: string) => Promise<number> = async (text: string) => estimateTokens(text);
    if (input.model) {
      const countTask = context.own(new CountTokensTask({ defaults: { model: input.model } }));
      countFn = async (text: string): Promise<number> => {
        try {
          const result = await countTask.run({ text });
          return result.count as number;
        } catch (_err) {
          // Fall back to local token estimation if CountTokensTask is unavailable or fails.
          return estimateTokens(text);
        }
      };
    }

    const chunks: ChunkRecord[] = [];

    if (strategy === "hierarchical") {
      await this.chunkHierarchically(root, [], [], doc_id, tokenBudget, chunks, countFn);
    } else {
      await this.chunkFlat(root, doc_id, tokenBudget, chunks, countFn);
    }
    return {
      doc_id,
      chunks,
      text: chunks.map((c) => c.text),
      count: chunks.length,
    };
  }

  /**
   * Hierarchical chunking that respects document structure.
   *
   * `headingPath` accumulates the titles of ancestor *section* nodes only
   * (the document root's title is intentionally excluded), so leaves can be
   * prefixed with a `"Section > Subsection"` breadcrumb. This is a well-known
   * RAG win: the embedding picks up the topical keywords from the heading
   * hierarchy, and the LLM in the answer phase doesn't have to guess what
   * the chunk is about — both effects matter most on small models, which
   * otherwise pad with plausible-sounding but unsupported claims.
   *
   * The document root title is deliberately omitted: it's already carried
   * on the document's `metadata.title` (and surfaces to the chat layer as
   * the reference label), and including it inside chunk text encourages
   * small models to synthesize fake URLs by pattern-matching the brand
   * name onto the section slug — e.g. a doc titled "Workglow" plus a
   * "Secret Management" section produced fabricated links like
   * `https://workglow.com/help/secret-management`.
   */
  private async chunkHierarchically(
    node: DocumentNode,
    nodePath: string[],
    headingPath: string[],
    doc_id: string,
    tokenBudget: TokenBudget,
    chunks: ChunkRecord[],
    countFn: (text: string) => Promise<number>
  ): Promise<void> {
    const currentPath = [...nodePath, node.nodeId];
    const currentHeadings =
      node.kind === NodeKind.SECTION &&
      typeof (node as SectionNode).title === "string" &&
      (node as SectionNode).title.trim().length > 0
        ? [...headingPath, (node as SectionNode).title.trim()]
        : headingPath;

    if (!hasChildren(node)) {
      await this.chunkText(
        node.text,
        currentPath,
        currentHeadings,
        doc_id,
        tokenBudget,
        chunks,
        node.nodeId,
        countFn
      );
      return;
    }

    const children = getChildren(node);
    for (const child of children) {
      await this.chunkHierarchically(
        child,
        currentPath,
        currentHeadings,
        doc_id,
        tokenBudget,
        chunks,
        countFn
      );
    }
  }

  /**
   * Chunk a single text string, using countFn for token counting.
   * countFn always returns a number -- it falls back to estimation internally
   * when no real tokenizer is available.
   *
   * `headingPath` is prepended to each emitted chunk as a `"A > B > C\n\n"`
   * breadcrumb and its tokens are charged against the chunk budget so the
   * combined chunk (prefix + body) still fits `maxTokensPerChunk -
   * reservedTokens`. If charging the prefix would leave no room for any
   * body, the prefix is dropped for this leaf so we always make progress.
   */
  private async chunkText(
    text: string,
    nodePath: string[],
    headingPath: string[],
    doc_id: string,
    tokenBudget: TokenBudget,
    chunks: ChunkRecord[],
    leafNodeId: string,
    countFn: (text: string) => Promise<number>
  ): Promise<void> {
    // Skip header-only chunks: nothing useful to retrieve or cite.
    if (text.trim().length === 0) return;

    const budgetAfterReserved = tokenBudget.maxTokensPerChunk - tokenBudget.reservedTokens;
    const overlapTokens = tokenBudget.overlapTokens;

    if (budgetAfterReserved <= 0) {
      throw new TaskInvalidInputError(
        `Invalid token budget: reservedTokens (${tokenBudget.reservedTokens}) must be less than maxTokensPerChunk (${tokenBudget.maxTokensPerChunk})`
      );
    }

    const breadcrumb = headingPath.join(" > ");
    const candidatePrefix = breadcrumb ? `${breadcrumb}\n\n` : "";
    const prefixTokens = candidatePrefix ? await countFn(candidatePrefix) : 0;
    // Drop the prefix if it would leave no room for body; never let the prefix
    // eat the whole chunk.
    const usePrefix = prefixTokens > 0 && prefixTokens < budgetAfterReserved;
    const prefix = usePrefix ? candidatePrefix : "";
    const effectivePrefixTokens = usePrefix ? prefixTokens : 0;
    const maxTokens = budgetAfterReserved - effectivePrefixTokens;

    if (overlapTokens >= maxTokens) {
      throw new TaskInvalidInputError(
        `Invalid token budget: overlapTokens (${overlapTokens}) must be less than effective maxTokens (${maxTokens})`
      );
    }

    const count = await countFn(text);
    if (count <= maxTokens) {
      chunks.push({
        chunkId: uuid4(),
        doc_id,
        text: prefix + text,
        nodePath,
        depth: nodePath.length,
        leafNodeId,
        // sectionTitles is what the chat layer slugifies into a URL `#anchor`
        // so retrieved chunks can deep-link to the specific section of the
        // rendered page. Copy so callers can't mutate the chunker's
        // internal accumulator.
        sectionTitles: [...headingPath],
      });
      return;
    }

    // Binary search for the character boundary that corresponds to targetTokens.
    // countFn handles the estimation fallback, so we always use it.
    // Uses ceil-biased midpoint so that when hi = lo + 1, mid = hi is always checked,
    // preventing the boundary from stalling at startChar on the last character of text.
    const findCharBoundary = async (startChar: number, targetTokens: number): Promise<number> => {
      let lo = startChar;
      let hi = Math.min(startChar + targetTokens * 6, text.length); // generous upper bound
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const count = await countFn(text.substring(startChar, mid));
        if (count <= targetTokens) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      return lo;
    };

    let startOffset = 0;

    while (startOffset < text.length) {
      const boundary = await findCharBoundary(startOffset, maxTokens);
      // Ensure endOffset always advances past startOffset to prevent an infinite loop.
      // In the extreme edge case where even one character exceeds maxTokens, we
      // include that character anyway (the chunk may be slightly oversize).
      const endOffset = Math.max(Math.min(boundary, text.length), startOffset + 1);

      chunks.push({
        chunkId: uuid4(),
        doc_id,
        text: prefix + text.substring(startOffset, endOffset),
        nodePath,
        depth: nodePath.length,
        leafNodeId,
        sectionTitles: [...headingPath],
      });

      if (endOffset >= text.length) break;

      const nextStart = await findCharBoundary(startOffset, maxTokens - overlapTokens);
      // Ensure we always make forward progress to prevent an infinite loop.
      startOffset = nextStart > startOffset ? nextStart : endOffset;
    }
  }

  /**
   * Flat chunking (ignores hierarchy). The document title is intentionally
   * NOT prepended here — see the rationale on `chunkHierarchically`. The
   * doc title rides along on `metadata.title` instead, which is what the
   * chat layer surfaces as the reference label.
   */
  private async chunkFlat(
    root: DocumentNode,
    doc_id: string,
    tokenBudget: TokenBudget,
    chunks: ChunkRecord[],
    countFn: (text: string) => Promise<number>
  ): Promise<void> {
    const allText = this.collectAllText(root);
    await this.chunkText(
      allText,
      [root.nodeId],
      [],
      doc_id,
      tokenBudget,
      chunks,
      root.nodeId,
      countFn
    );
  }

  private collectAllText(node: DocumentNode): string {
    const texts: string[] = [];

    const traverse = (n: DocumentNode) => {
      if (!hasChildren(n)) {
        texts.push(n.text);
      } else {
        for (const child of getChildren(n)) {
          traverse(child);
        }
      }
    };

    traverse(node);
    return texts.join("\n\n");
  }
}

export const hierarchicalChunker = (
  input: HierarchicalChunkerTaskInput,
  config?: HierarchicalChunkerTaskConfig,
  runConfig?: Partial<IRunConfig>
) => {
  return new HierarchicalChunkerTask(config).run(input, runConfig);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    hierarchicalChunker: CreateWorkflow<
      HierarchicalChunkerTaskInput,
      HierarchicalChunkerTaskOutput,
      HierarchicalChunkerTaskConfig
    >;
  }
}

Workflow.prototype.hierarchicalChunker = CreateWorkflow(HierarchicalChunkerTask);
