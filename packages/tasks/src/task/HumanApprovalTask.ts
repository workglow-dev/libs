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
  Workflow,
} from "@workglow/task-graph";
import type { HumanResponseAction, IHumanRequest } from "@workglow/util";
import { resolveHumanConnector, uuid4 } from "@workglow/util";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";

const humanApprovalConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    targetHumanId: {
      type: "string",
      title: "Target Human",
      description: "Identifier of the human to ask for approval",
      default: "default",
    },
    message: {
      type: "string",
      title: "Message",
      description: "Explanatory message shown to the approver",
      "x-ui-editor": "textarea",
    },
    metadata: {
      type: "object",
      additionalProperties: true,
      "x-ui-hidden": true,
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type HumanApprovalTaskConfig = TaskConfig & {
  /** Target human identifier — defaults to "default" */
  targetHumanId?: string;
  /** Explanatory message */
  message?: string;
  /** Arbitrary metadata passed to the connector */
  metadata?: Record<string, unknown>;
};

const inputSchema = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      title: "Prompt",
      description: "Dynamic prompt text merged into the approval message",
    },
    context: {
      type: "object",
      additionalProperties: true,
      title: "Context",
      description: "Dynamic context data merged into the request metadata",
      "x-ui-hidden": true,
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

/**
 * Describes what is being approved: the input `context`, shown to the person as
 * read-only details. A confirm carries no answer content, so this is not a form.
 */
const approvalDetailsSchema = {
  type: "object",
  properties: {},
  additionalProperties: true,
} as const satisfies DataPortSchema;

const approvalOutputSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      title: "Action",
      description: "The human's action: accept, decline, or cancel",
      enum: ["accept", "decline", "cancel"],
    },
    approved: {
      type: "boolean",
      title: "Approved",
      description: "Whether the human approved the request",
    },
    reason: {
      type: "string",
      title: "Reason",
      description: "Optional explanation for the decision",
    },
  },
  required: ["action", "approved"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type HumanApprovalTaskInput = FromSchema<typeof inputSchema>;

export type HumanApprovalTaskOutput = {
  readonly action: HumanResponseAction;
  readonly approved: boolean;
  readonly reason?: string;
};

/**
 * Convenience task for the common approve/deny pattern.
 *
 * Presents the human with an approval dialog via MCP elicitation and returns
 * `{ action, approved, reason }`. Uses "single" mode — one question, one answer.
 *
 * If the human declines or cancels at the MCP level, `approved` is false and
 * `action` reflects the specific choice.
 */
export class HumanApprovalTask extends Task<
  HumanApprovalTaskInput,
  HumanApprovalTaskOutput,
  HumanApprovalTaskConfig
> {
  static override readonly type = "HumanApprovalTask";
  static override readonly category = "Human";
  public static override title = "Human Approval";
  public static override description =
    "Pauses execution to request approval from a human (approve/deny) via MCP elicitation";
  public static override cachePolicy: CachePolicy = { kind: "none" };

  public static override configSchema(): DataPortSchema {
    return humanApprovalConfigSchema;
  }

  static override inputSchema(): DataPortSchema {
    return inputSchema;
  }

  static override outputSchema(): DataPortSchema {
    return approvalOutputSchema;
  }

  override async execute(
    input: HumanApprovalTaskInput,
    context: IExecuteContext
  ): Promise<HumanApprovalTaskOutput> {
    const connector = resolveHumanConnector(context);
    const requestId = uuid4();

    const message = input.prompt
      ? this.config.message
        ? `${this.config.message}\n\n${input.prompt}`
        : input.prompt
      : (this.config.message ?? "");

    const request: IHumanRequest = {
      requestId,
      targetHumanId: this.config.targetHumanId ?? "default",
      // A confirm, which every host draws as an approval -- Accept, Decline, Cancel.
      // Sent as an elicit with an "approved" checkbox it was drawn as a form, where
      // Accept with the box unticked was a denial and a host treating Accept as yes
      // (as tool approvals do) reported every approval as one.
      kind: "confirm",
      message,
      contentSchema: approvalDetailsSchema,
      contentData: input.context,
      expectsResponse: true,
      mode: "single",
      metadata: input.context
        ? { ...this.config.metadata, ...input.context }
        : this.config.metadata,
    };

    if (context.signal.aborted) {
      throw new TaskAbortedError("Task aborted before requesting human approval");
    }

    let response: Awaited<ReturnType<typeof connector.send>>;
    try {
      response = await connector.send(request, context.signal);
    } catch (err) {
      if (context.signal.aborted) {
        throw new TaskAbortedError("Task aborted during human approval");
      }
      throw err;
    }

    // Accept is the approval. An explicit `approved: false` in the content -- a host
    // still drawing the old checkbox form -- is honoured as a denial, so a change of
    // request kind can never turn that host's "no" into a yes. Decline refuses;
    // Cancel walks away undecided. A reason rides along when the host sends one.
    const reason =
      typeof response.content?.reason === "string" ? response.content.reason : undefined;
    return {
      action: response.action,
      approved: response.action === "accept" && response.content?.approved !== false,
      ...(reason !== undefined ? { reason } : {}),
    };
  }
}

declare module "@workglow/task-graph" {
  interface Workflow {
    humanApproval: CreateWorkflow<
      HumanApprovalTaskInput,
      HumanApprovalTaskOutput,
      HumanApprovalTaskConfig
    >;
  }
}

Workflow.prototype.humanApproval = CreateWorkflow(HumanApprovalTask);
