/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { CreateWorkflow, Task, Workflow } from "@workglow/task-graph";

import type { IExecuteContext, IRunConfig, TaskConfig } from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import type { Capability } from "../capability/Capabilities";

export const QueryExpansionMethod = {
  MULTI_QUERY: "multi-query",
  SYNONYMS: "synonyms",
} as const;

export type QueryExpansionMethod = (typeof QueryExpansionMethod)[keyof typeof QueryExpansionMethod];

const inputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      title: "Query",
      description: "The original query to expand",
    },
    method: {
      type: "string",
      enum: Object.values(QueryExpansionMethod),
      title: "Expansion Method",
      description: "Method to use for query expansion",
      default: QueryExpansionMethod.MULTI_QUERY,
    },
    numVariations: {
      type: "number",
      title: "Number of Variations",
      description: "Number of query variations to generate",
      minimum: 1,
      maximum: 10,
      default: 3,
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    query: {
      type: "array",
      items: { type: "string" },
      title: "Expanded Queries",
      description: "Generated query variations",
    },
    originalQuery: {
      type: "string",
      title: "Original Query",
      description: "The original input query",
    },
    method: {
      type: "string",
      title: "Method Used",
      description: "The expansion method that was used",
    },
    count: {
      type: "number",
      title: "Count",
      description: "Number of queries generated",
    },
  },
  required: ["query", "originalQuery", "method", "count"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type QueryExpanderTaskInput = {
  method?: "multi-query" | "synonyms" | undefined;
  numVariations?: number | undefined;
  query: string;
};
export type QueryExpanderTaskOutput = {
  count: number;
  query: string[];
  method: string;
  originalQuery: string;
};
export type QueryExpanderTaskConfig = TaskConfig<QueryExpanderTaskInput>;

/**
 * Rule-based query expansion for improved retrieval recall.
 * Supports `multi-query` (question-word variations) and `synonyms` (keyword swaps).
 * Note: LLM-driven methods (HyDE, paraphrase) were removed until a real
 * implementation lands — use a TextGenerationTask upstream for those.
 */
export class QueryExpanderTask extends Task<
  QueryExpanderTaskInput,
  QueryExpanderTaskOutput,
  QueryExpanderTaskConfig
> {
  public static override type = "QueryExpanderTask";
  /** Heuristic: calls no model, so it requires no model capability. */
  public static readonly requires: readonly Capability[] = [] as const satisfies Capability[];
  public static override category = "RAG";
  public static override title = "Query Expander";
  public static override description = "Expand queries to improve retrieval coverage";
  public static override cacheable = true;

  public static override inputSchema(): DataPortSchema {
    return inputSchema as DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return outputSchema as DataPortSchema;
  }

  override async execute(
    input: QueryExpanderTaskInput,
    context: IExecuteContext
  ): Promise<QueryExpanderTaskOutput> {
    const { query, method = QueryExpansionMethod.MULTI_QUERY, numVariations = 3 } = input;

    let queries: string[];
    switch (method) {
      case QueryExpansionMethod.SYNONYMS:
        queries = this.synonymExpansion(query, numVariations);
        break;
      case QueryExpansionMethod.MULTI_QUERY:
      default:
        queries = this.multiQueryExpansion(query, numVariations);
        break;
    }

    if (!queries.includes(query)) {
      queries.unshift(query);
    }

    return {
      query: queries,
      originalQuery: query,
      method,
      count: queries.length,
    };
  }

  private multiQueryExpansion(query: string, numVariations: number): string[] {
    const queries: string[] = [query];
    const variations: string[] = [];

    if (query.toLowerCase().startsWith("what")) {
      variations.push(query.replace(/^what/i, "Which"));
      variations.push(query.replace(/^what/i, "Can you explain"));
    } else if (query.toLowerCase().startsWith("how")) {
      variations.push(query.replace(/^how/i, "What is the method to"));
      variations.push(query.replace(/^how/i, "In what way"));
    } else if (query.toLowerCase().startsWith("why")) {
      variations.push(query.replace(/^why/i, "What is the reason"));
      variations.push(query.replace(/^why/i, "For what purpose"));
    } else if (query.toLowerCase().startsWith("where")) {
      variations.push(query.replace(/^where/i, "In which location"));
      variations.push(query.replace(/^where/i, "At what place"));
    }

    if (!query.toLowerCase().startsWith("tell me")) {
      variations.push(`Tell me about ${query.toLowerCase()}`);
    }
    if (!query.toLowerCase().startsWith("explain")) {
      variations.push(`Explain ${query.toLowerCase()}`);
    }

    for (let i = 0; i < Math.min(numVariations - 1, variations.length); i++) {
      if (variations[i] && !queries.includes(variations[i])) {
        queries.push(variations[i]);
      }
    }

    return queries;
  }

  private synonymExpansion(query: string, numVariations: number): string[] {
    const queries: string[] = [query];

    const synonyms: Record<string, string[]> = {
      find: ["locate", "discover", "search for"],
      create: ["make", "build", "generate"],
      delete: ["remove", "erase", "eliminate"],
      update: ["modify", "change", "edit"],
      show: ["display", "present", "reveal"],
      explain: ["describe", "clarify", "elaborate"],
      help: ["assist", "aid", "support"],
      problem: ["issue", "challenge", "difficulty"],
      solution: ["answer", "resolution", "fix"],
      method: ["approach", "technique", "way"],
    };

    const words = query.toLowerCase().split(/\s+/);
    let variationsGenerated = 0;

    for (const [word, syns] of Object.entries(synonyms)) {
      if (variationsGenerated >= numVariations - 1) break;
      const wordIndex = words.indexOf(word);
      if (wordIndex !== -1) {
        for (const syn of syns) {
          if (variationsGenerated >= numVariations - 1) break;
          const newWords = [...words];
          newWords[wordIndex] = syn;
          const capitalizedQuery = this.preserveCapitalization(query, newWords.join(" "));
          if (!queries.includes(capitalizedQuery)) {
            queries.push(capitalizedQuery);
            variationsGenerated++;
          }
        }
      }
    }

    return queries;
  }

  private preserveCapitalization(original: string, modified: string): string {
    if (original[0] === original[0].toUpperCase()) {
      return modified.charAt(0).toUpperCase() + modified.slice(1);
    }
    return modified;
  }
}

export const queryExpander = (
  input: QueryExpanderTaskInput,
  config?: QueryExpanderTaskConfig,
  runConfig?: Partial<IRunConfig>
) => {
  return new QueryExpanderTask(config).run(input, runConfig);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    queryExpander: CreateWorkflow<
      QueryExpanderTaskInput,
      QueryExpanderTaskOutput,
      QueryExpanderTaskConfig
    >;
  }
}

Workflow.prototype.queryExpander = CreateWorkflow(QueryExpanderTask);
