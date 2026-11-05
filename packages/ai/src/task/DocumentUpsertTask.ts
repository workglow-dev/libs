/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DocumentMetadata, DocumentNode, KnowledgeBase } from "@workglow/knowledge-base";
import { Document, DocumentMetadataSchema, TypeKnowledgeBase } from "@workglow/knowledge-base";
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
import type { DataPortSchema } from "@workglow/util/schema";
import type { Capability } from "../capability/Capabilities";

const inputSchema = {
  type: "object",
  properties: {
    knowledgeBase: TypeKnowledgeBase({
      title: "Knowledge Base",
      description: "The knowledge base instance to store the document in",
    }),
    doc_id: {
      type: "string",
      title: "Document ID",
      description: "The document ID (from the parser)",
    },
    documentTree: {
      title: "Document Tree",
      description: "The hierarchical document tree to persist",
    },
    title: {
      type: "string",
      title: "Title",
      description:
        "Optional human-readable title. If provided, overrides metadata.title. " +
        "Either this or metadata.title must be supplied.",
    },
    metadata: {
      ...DocumentMetadataSchema,
      // Override the title requirement inherited from DocumentMetadataSchema.
      // The task framework materializes absent optional object inputs as `{}`,
      // which would otherwise fail `required: ["title"]` validation here.
      // Title presence is enforced at runtime in execute() instead, so the
      // `title` and `metadata.title` paths can each independently satisfy it.
      required: [],
      title: "Metadata",
      description:
        "Optional document metadata. May contain `title` (unless the top-level " +
        "`title` input is also provided), `sourceUri`, `createdAt`, and any " +
        "additional caller-defined fields (the schema is open).",
    },
  },
  required: ["knowledgeBase", "doc_id", "documentTree"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    doc_id: {
      type: "string",
      title: "Document ID",
      description: "The document ID (passed through after persistence)",
    },
  },
  required: ["doc_id"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type DocumentUpsertTaskInput = {
  title?: string | undefined;
  metadata?:
    | {
        [x: string]: unknown;
        title?: string | undefined;
        sourceUri?: string | undefined;
        createdAt?: string | undefined;
      }
    | undefined;
  doc_id: string;
  documentTree: unknown;
  knowledgeBase: unknown;
};
export type DocumentUpsertTaskOutput = { doc_id: string };
export type DocumentUpsertTaskConfig = TaskConfig<DocumentUpsertTaskInput>;

/**
 * Persists a parsed document tree to a knowledge base. Sits between
 * `StructuralParserTask` and `HierarchicalChunkerTask` in a typical RAG
 * ingest pipeline so that the document row exists in tabular storage
 * before any chunk-vector row references its `doc_id`.
 *
 * Pure side-effect task: input `doc_id` is preserved on the output so
 * downstream tasks can chain on the upsert completing successfully.
 */
export class DocumentUpsertTask extends Task<
  DocumentUpsertTaskInput,
  DocumentUpsertTaskOutput,
  DocumentUpsertTaskConfig
> {
  public static override type = "DocumentUpsertTask";
  /** Storage task — no provider capability required. */
  public static readonly requires: readonly Capability[] = [] as const satisfies Capability[];
  public static override category = "Document";
  public static override title = "Add Document";
  public static override description = "Persist a parsed document tree to a knowledge base";
  public static override cachePolicy: CachePolicy = { kind: "none" }; // Has side effects

  /** Declared so a host can ask what this reaches before running it. */
  public static override entitlements(): TaskEntitlements {
    return {
      entitlements: [
        { id: Entitlements.STORAGE_WRITE, reason: "Writes a document into a knowledge base" },
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
    input: DocumentUpsertTaskInput,
    context: IExecuteContext
  ): Promise<DocumentUpsertTaskOutput> {
    const { knowledgeBase, doc_id, documentTree, title, metadata } = input;
    const kb = knowledgeBase as KnowledgeBase;

    // Merge: explicit `title` wins over `metadata.title`. Open `metadata` shape
    // (additionalProperties: true) means any extra frontmatter fields the caller
    // passed are persisted on the Document record unchanged.
    const merged: DocumentMetadata = {
      ...((metadata ?? {}) as DocumentMetadata),
      ...(title !== undefined ? { title } : {}),
    };
    if (!merged.title) {
      throw new TaskInvalidInputError(
        "DocumentUpsertTask: title is required — provide it via the 'title' input or 'metadata.title'"
      );
    }

    await context.updateProgress(1, "Upserting document");

    const document = new Document(documentTree as DocumentNode, merged, [], doc_id);
    const stored = await kb.upsertDocument(document);

    return {
      doc_id: stored.doc_id ?? doc_id,
    };
  }
}

export const documentUpsert = (
  input: DocumentUpsertTaskInput,
  config?: DocumentUpsertTaskConfig,
  runConfig?: Partial<IRunConfig>
) => {
  return new DocumentUpsertTask(config).run(input, runConfig);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    documentUpsert: CreateWorkflow<
      DocumentUpsertTaskInput,
      DocumentUpsertTaskOutput,
      DocumentUpsertTaskConfig
    >;
  }
}

Workflow.prototype.documentUpsert = CreateWorkflow(DocumentUpsertTask);
