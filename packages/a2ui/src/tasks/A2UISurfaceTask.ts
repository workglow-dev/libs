/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CachePolicy, IExecuteContext, TaskConfig } from "@workglow/task-graph";
import {
  CreateWorkflow,
  Task,
  TaskAbortedError,
  TaskConfigSchema,
  TaskConfigurationError,
  Workflow,
} from "@workglow/task-graph";
import { uuid4 } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import type { A2UICatalogSpec } from "../catalog/CatalogSpec";
import { A2UI_BASIC_CATALOG } from "../catalog/basicCatalog";
import { batchCatalogIssues } from "../catalog/validateAgainstCatalog";
import type { A2UIServerMessage } from "../protocol/messages";
import { validateServerMessages } from "../protocol/validate";
import type { A2UIPresentStatus } from "./A2UIConnector";
import { resolveA2UIConnector } from "./A2UIConnector";

const inputSchema = {
  type: "object",
  properties: {
    messages: {
      type: "array",
      items: { type: "object", additionalProperties: true },
      title: "Messages",
      description:
        "A2UI v0.9 messages: createSurface, then updateDataModel and updateComponents for it",
    },
    expectsAction: {
      type: "boolean",
      title: "Expects Action",
      description:
        "Block until the person uses the surface. Leave off for a surface that only reports.",
      default: true,
    },
  },
  required: ["messages"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      title: "Status",
      description:
        '"action" when the person used the surface, "dismissed" when they closed it, "presented" when nothing was expected',
      enum: ["action", "dismissed", "presented"],
    },
    eventName: {
      type: "string",
      title: "Event Name",
      description: "The action name the component declared, when one fired",
    },
    context: {
      type: "object",
      additionalProperties: true,
      title: "Context",
      description: "The action's context with its data bindings resolved",
    },
    sourceComponentId: {
      type: "string",
      title: "Source Component",
      description: "Id of the component the action came from",
    },
    surfaceId: {
      type: "string",
      title: "Surface",
      description: "Id of the surface the batch created",
    },
  },
  required: ["status", "surfaceId"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type A2UISurfaceTaskInput = {
  messages: readonly A2UIServerMessage[];
  expectsAction?: boolean;
};

export type A2UISurfaceTaskOutput = {
  status: A2UIPresentStatus;
  eventName?: string;
  context?: Record<string, unknown>;
  sourceComponentId?: string;
  surfaceId: string;
};

/**
 * The base task config plus this task's own field.
 *
 * Required, not decorative: `Task` validates config against this schema with
 * `additionalProperties: false`, so without declaring `catalog` here the
 * documented per-run catalog throws during construction and can never be used.
 */
const configSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    catalog: {
      type: "object",
      additionalProperties: true,
      title: "Catalog",
      description: "Component allowlist this run enforces; defaults to the A2UI basic catalog",
      "x-ui-hidden": true,
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type A2UISurfaceTaskConfig = TaskConfig & {
  /** The catalog this run enforces; defaults to the A2UI basic catalog. */
  catalog?: A2UICatalogSpec;
};

/**
 * Draws an A2UI surface for a person and reports what they did with it.
 *
 * Both checks run here rather than in the host: {@link validateServerMessages}
 * for the batch's own shape, and {@link batchCatalogIssues} for what it asks the
 * renderer to draw. Putting them in the renderer would mean every renderer
 * repeating them, and the one that forgets is the one that draws whatever an
 * agent sent. A refusal is a task error with the reason in it, so the agent that
 * wrote the batch can read what was wrong and send a corrected one.
 *
 * Not cacheable: the output is a person's answer, and replaying one is how a
 * second run reports a press nobody made.
 */
export class A2UISurfaceTask extends Task<
  A2UISurfaceTaskInput,
  A2UISurfaceTaskOutput,
  A2UISurfaceTaskConfig
> {
  static override readonly type = "A2UISurfaceTask";
  static override readonly category = "Human";
  public static override title = "A2UI Surface";
  public static override description =
    "Draws an agent-authored A2UI surface for a person and reports the action they took";
  public static override cachePolicy: CachePolicy = { kind: "none" };

  public static override configSchema(): DataPortSchema {
    return configSchema;
  }

  static override inputSchema(): DataPortSchema {
    return inputSchema;
  }

  static override outputSchema(): DataPortSchema {
    return outputSchema;
  }

  override async execute(
    input: A2UISurfaceTaskInput,
    context: IExecuteContext
  ): Promise<A2UISurfaceTaskOutput> {
    const catalog = this.config.catalog ?? A2UI_BASIC_CATALOG;
    const parsed = validateServerMessages(input.messages);
    if (!parsed.ok) throw new TaskConfigurationError(`A2UI batch refused: ${parsed.reason}`);

    const issues = batchCatalogIssues(parsed.value, { catalog });
    if (issues.length > 0) {
      throw new TaskConfigurationError(
        `A2UI batch refused: ${issues.map((issue) => issue.message).join("; ")}`
      );
    }

    // One surface per batch. The protocol allows several and this task's output
    // models one — `surfaceId`, one `eventName`, one `context` — so a two-surface
    // batch would report an action without saying which surface produced it, and
    // hand the connector one `catalogId` for both.
    const creations = parsed.value.filter((message) => "createSurface" in message);
    if (creations.length > 1) {
      throw new TaskConfigurationError(
        `A2UI batch refused: it creates ${creations.length} surfaces, and this task presents one`
      );
    }
    const created = creations[0];
    // `validateServerMessages` refuses any message naming a surface it did not
    // see created, so a batch with no `createSurface` has no messages at all —
    // which it also refuses. Stated rather than assumed, since this is the one
    // field the output promises.
    if (!created || !("createSurface" in created)) {
      throw new TaskConfigurationError("A2UI batch refused: it creates no surface");
    }
    const surfaceId = created.createSurface.surfaceId;

    const connector = resolveA2UIConnector(context);
    if (context.signal.aborted)
      throw new TaskAbortedError("Task aborted before presenting a surface");

    const expectsAction = input.expectsAction !== false;
    let result;
    try {
      result = await connector.present(
        {
          requestId: uuid4(),
          messages: parsed.value,
          catalogId: created.createSurface.catalogId,
          expectsAction,
        },
        context.signal
      );
    } catch (error) {
      if (context.signal.aborted)
        throw new TaskAbortedError("Task aborted while presenting a surface");
      throw error;
    }

    const action = result.status === "action" ? result.action : undefined;
    return {
      status: result.status,
      surfaceId,
      eventName: action?.name,
      context: action?.context,
      sourceComponentId: action?.sourceComponentId,
    };
  }
}

declare module "@workglow/task-graph" {
  interface Workflow {
    a2uiSurface: CreateWorkflow<A2UISurfaceTaskInput, A2UISurfaceTaskOutput, A2UISurfaceTaskConfig>;
  }
}

Workflow.prototype.a2uiSurface = CreateWorkflow(A2UISurfaceTask);
