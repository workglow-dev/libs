/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { getChildren, hasChildren } from "@workglow/knowledge-base";

import type {
  DocumentNode,
  DocumentRootNode,
  Entity,
  NodeEnrichment,
} from "@workglow/knowledge-base";
import type { IExecuteContext, IRunConfig, TaskConfig } from "@workglow/task-graph";
import { CreateWorkflow, Task, TaskConfigSchema, Workflow } from "@workglow/task-graph";
import type { DataPortSchema } from "@workglow/util/schema";
import type { Capability } from "../capability/Capabilities";
import type { ModelConfig } from "../model/ModelSchema";
import { TextNamedEntityRecognitionTask } from "./TextNamedEntityRecognitionTask";
import { TextSummaryTask } from "./TextSummaryTask";
import { TypeModel } from "./base/AiTaskSchemas";

const inputSchema = {
  type: "object",
  properties: {
    doc_id: {
      type: "string",
      title: "Document ID",
      description: "The document ID",
    },
    documentTree: {
      type: "object",
      additionalProperties: true,
      title: "Document Tree",
      description: "The hierarchical document tree to enrich",
    },
    generateSummaries: {
      type: "boolean",
      title: "Generate Summaries",
      description: "Whether to generate summaries for sections",
      default: true,
    },
    extractEntities: {
      type: "boolean",
      title: "Extract Entities",
      description: "Whether to extract named entities",
      default: true,
    },
    summaryModel: TypeModel("model:TextSummaryTask", {
      title: "Summary Model",
      description: "Model to use for summary generation (optional)",
    }),
    summaryThreshold: {
      type: "number",
      title: "Summary Threshold",
      description: "Minimum combined text length (node + children) to warrant generating a summary",
      default: 500,
    },
    nerModel: TypeModel("model:TextNamedEntityRecognitionTask", {
      title: "NER Model",
      description: "Model to use for named entity recognition (optional)",
    }),
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
    documentTree: {
      title: "Document Tree",
      description: "The enriched document tree",
    },
    summaryCount: {
      type: "number",
      title: "Summary Count",
      description: "Number of summaries generated",
    },
    entityCount: {
      type: "number",
      title: "Entity Count",
      description: "Number of entities extracted",
    },
  },
  required: ["doc_id", "documentTree", "summaryCount", "entityCount"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type DocumentEnricherTaskInput = Omit<
  {
    doc_id: string;
    documentTree?: { [x: string]: unknown } | undefined;
    generateSummaries?: boolean | undefined;
    extractEntities?: boolean | undefined;
    summaryModel?: string | ModelConfig | undefined;
    summaryThreshold?: number | undefined;
    nerModel?: string | ModelConfig | undefined;
  },
  "documentTree"
> & { documentTree: DocumentRootNode };
export type DocumentEnricherTaskOutput = {
  doc_id: string;
  documentTree: unknown;
  summaryCount: number;
  entityCount: number;
};
export type DocumentEnricherTaskConfig = TaskConfig<DocumentEnricherTaskInput> & {
  /** Model calls (summaries and entity extraction) in flight at once. Default 4. */
  readonly concurrency?: number | undefined;
};

const DEFAULT_CONCURRENCY = 4;

const configSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    concurrency: {
      type: "integer",
      minimum: 1,
      default: DEFAULT_CONCURRENCY,
      title: "Concurrency",
      description: "Model calls (summaries and entity extraction) in flight at once",
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

type Slots = <T>(work: () => Promise<T>) => Promise<T>;

/** Runs at most `limit` pieces of work at once, the rest in the order they asked. */
function createSlots(limit: number): Slots {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await work();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

/**
 * Task for enriching document nodes with summaries and entities
 * Uses bottom-up propagation to roll up child information to parents
 */
export class DocumentEnricherTask extends Task<
  DocumentEnricherTaskInput,
  DocumentEnricherTaskOutput,
  DocumentEnricherTaskConfig
> {
  public static override type = "DocumentEnricherTask";
  /** Orchestration task — delegates to sub-tasks; no direct provider capability. */
  public static readonly requires: readonly Capability[] = [] as const satisfies Capability[];
  public static override category = "Document";
  public static override title = "Document Enricher";
  public static override description = "Enrich document nodes with summaries and entities";
  public static override cacheable = true;

  public static override inputSchema(): DataPortSchema {
    return inputSchema as DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return outputSchema as DataPortSchema;
  }

  public static override configSchema(): DataPortSchema {
    return configSchema;
  }

  /**
   * Bounds the model calls of one execution. The tree is walked all at once (a parent
   * waits on its children), so the calls are what is bounded, not the walk: a slot held
   * by a parent waiting on its children could never be given back.
   */
  private slots: Slots = createSlots(DEFAULT_CONCURRENCY);

  override async execute(
    input: DocumentEnricherTaskInput,
    context: IExecuteContext
  ): Promise<DocumentEnricherTaskOutput> {
    const {
      doc_id,
      documentTree,
      generateSummaries = true,
      extractEntities = true,
      summaryModel: summaryModelConfig,
      summaryThreshold = 500,
      nerModel: nerModelConfig,
    } = input;

    this.slots = createSlots(this.config?.concurrency ?? DEFAULT_CONCURRENCY);
    const slots = this.slots;
    const root: DocumentNode = documentTree;
    const summaryModel = summaryModelConfig ? (summaryModelConfig as ModelConfig) : undefined;
    const nerModel = nerModelConfig ? (nerModelConfig as ModelConfig) : undefined;
    let summaryCount = 0;
    let entityCount = 0;

    const extract =
      extractEntities && nerModel
        ? async (text: string) => {
            const result = await slots(() =>
              context.own(new TextNamedEntityRecognitionTask()).run({ text, model: nerModel })
            );
            return (result.entities as Array<{ entity: string; word: string; score: number }>).map(
              (e) => ({
                type: e.entity,
                text: e.word,
                score: e.score,
              })
            );
          }
        : undefined;

    // Bottom-up enrichment
    const enrichedRoot = await this.enrichNode(
      root,
      context,
      generateSummaries && summaryModel ? summaryModel : undefined,
      summaryThreshold,
      extract,
      (count) => (summaryCount += count),
      (count) => (entityCount += count)
    );

    return {
      doc_id,
      documentTree: enrichedRoot,
      summaryCount,
      entityCount,
    };
  }

  /**
   * Enrich a node recursively (bottom-up)
   */
  private async enrichNode(
    node: DocumentNode,
    context: IExecuteContext,
    summaryModel: ModelConfig | undefined,
    summaryThreshold: number,
    extract: ((text: string) => Promise<Entity[]>) | undefined,
    onSummary: (count: number) => void,
    onEntity: (count: number) => void
  ): Promise<DocumentNode> {
    // If node has children, enrich them first
    let enrichedChildren: DocumentNode[] | undefined;
    if (hasChildren(node)) {
      const children = getChildren(node);
      enrichedChildren = await Promise.all(
        children.map((child) =>
          this.enrichNode(
            child,
            context,
            summaryModel,
            summaryThreshold,
            extract,
            onSummary,
            onEntity
          )
        )
      );
    }

    // Generate enrichment for this node
    const enrichment: NodeEnrichment = {};

    // Generate summary (for sections and documents)
    if (summaryModel && (node.kind === "section" || node.kind === "document")) {
      if (enrichedChildren && enrichedChildren.length > 0) {
        // Summary of children
        enrichment.summary = await this.generateSummary(
          node,
          enrichedChildren,
          context,
          summaryModel,
          summaryThreshold
        );
      } else {
        // Leaf section summary
        enrichment.summary = await this.generateLeafSummary(
          node.text,
          context,
          summaryModel,
          summaryThreshold
        );
      }
      if (enrichment.summary) {
        onSummary(1);
      }
    }

    // Extract entities
    if (extract) {
      enrichment.entities = await this.extractEntities(node, enrichedChildren, extract);
      if (enrichment.entities) {
        onEntity(enrichment.entities.length);
      }
    }

    // Create enriched node
    const enrichedNode: DocumentNode = {
      ...node,
      enrichment: Object.keys(enrichment).length > 0 ? enrichment : undefined,
    };

    if (enrichedChildren) {
      // @ts-expect-error - children are otherwise readonly
      enrichedNode.children = enrichedChildren;
    }

    return enrichedNode;
  }

  /**
   * Private method to summarize text using the TextSummaryTask
   */
  protected async summarize(
    text: string,
    context: IExecuteContext,
    model: ModelConfig
  ): Promise<string> {
    // TODO: Handle truncation of text if needed, based on model configuration
    return (await context.own(new TextSummaryTask()).run({ text, model })).text as string;
  }

  /**
   * Generate summary for a node with children
   */
  private async generateSummary(
    node: DocumentNode,
    children: DocumentNode[],
    context: IExecuteContext,
    model: ModelConfig,
    threshold: number
  ): Promise<string | undefined> {
    const textParts: string[] = [];

    // Include the node's own text
    const nodeText = node.text?.trim();
    if (nodeText) {
      textParts.push(nodeText);
    }

    // Include children summaries/texts
    const childTexts = children
      .map((child) => {
        if (child.enrichment?.summary) {
          return child.enrichment.summary;
        }
        return child.text;
      })
      .join(" ")
      .trim();

    if (childTexts) {
      textParts.push(childTexts);
    }

    const combinedText = textParts.join(" ").trim();
    if (!combinedText) {
      return undefined;
    }

    // Check if summary is warranted based on threshold
    if (combinedText.length < threshold) {
      return undefined;
    }

    const summaryParts: string[] = [];

    // Summarize the node's own text first
    if (nodeText) {
      const nodeSummary = await this.slots(() => this.summarize(nodeText, context, model));
      if (nodeSummary) {
        summaryParts.push(nodeSummary);
      }
    }

    // Include children summaries/texts
    if (childTexts) {
      summaryParts.push(childTexts);
    }

    const combinedSummaries = summaryParts.join(" ").trim();
    if (!combinedSummaries) {
      return undefined;
    }

    const result = await this.slots(() => this.summarize(combinedSummaries, context, model));
    return result;
  }

  /**
   * Generate summary for a leaf node
   */
  private async generateLeafSummary(
    text: string,
    context: IExecuteContext,
    model: ModelConfig,
    threshold: number
  ): Promise<string | undefined> {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return undefined;
    }

    // Check if summary is warranted based on threshold
    if (trimmedText.length < threshold) {
      return undefined;
    }

    const result = await this.slots(() => this.summarize(trimmedText, context, model));
    return result;
  }

  /**
   * Extract and roll up entities from node and children
   */
  private async extractEntities(
    node: DocumentNode,
    children: DocumentNode[] | undefined,
    extract: ((text: string) => Promise<Entity[]>) | undefined
  ): Promise<Entity[] | undefined> {
    const entities: Entity[] = [];

    // Collect from children first
    if (children) {
      for (const child of children) {
        if (child.enrichment?.entities) {
          entities.push(...child.enrichment.entities);
        }
      }
    }

    const text = node.text?.trim();
    if (text && extract) {
      const nodeEntities = await extract(text);
      if (nodeEntities?.length) {
        entities.push(...nodeEntities);
      }
    }

    // Deduplicate by text
    const unique = new Map<string, Entity>();
    for (const entity of entities) {
      const key = `${entity.text}::${entity.type}`;
      const existing = unique.get(key);
      if (!existing || entity.score > existing.score) {
        unique.set(key, entity);
      }
    }

    const result = Array.from(unique.values());
    return result.length > 0 ? result : undefined;
  }
}

export const documentEnricher = (
  input: DocumentEnricherTaskInput,
  config?: DocumentEnricherTaskConfig,
  runConfig?: Partial<IRunConfig>
) => {
  return new DocumentEnricherTask(config).run(input, runConfig);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    documentEnricher: CreateWorkflow<
      DocumentEnricherTaskInput,
      DocumentEnricherTaskOutput,
      DocumentEnricherTaskConfig
    >;
  }
}

Workflow.prototype.documentEnricher = CreateWorkflow(DocumentEnricherTask);
