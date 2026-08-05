/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CachePolicy,
  IExecuteContext,
  TaskConfig,
  TaskEntitlements,
} from "@workglow/task-graph";
import { CreateWorkflow, Task, Workflow } from "@workglow/task-graph";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";
import {
  compactPayload,
  postWebhookJson,
  resolveWebhookUrl,
  webhookBaseEntitlements,
  webhookPrivateEntitlements,
} from "../util/WebhookPost";

const inputSchema = {
  type: "object",
  properties: {
    url: {
      type: "string",
      format: "uri",
      title: "Webhook URL",
      description:
        "Slack incoming webhook URL. The token is part of the path, so it is treated as a secret and never echoed back.",
    },
    text: {
      type: "string",
      title: "Text",
      description: "Message text, also used as the notification fallback for block messages",
    },
    blocks: {
      type: "array",
      items: { type: "object", additionalProperties: true },
      title: "Blocks",
      description: "Slack Block Kit blocks",
    },
    username: {
      type: "string",
      title: "Username",
      description: "Overrides the display name of the posting bot",
    },
    icon_emoji: {
      type: "string",
      title: "Icon Emoji",
      description: "Overrides the bot icon, e.g. :robot_face:",
    },
    url_credential_key: {
      type: "string",
      format: "credential",
      title: "Credential Key",
      description:
        "Key to look up in the credential store. The resolved value is the entire webhook URL — the secret itself, not a bearer token — and takes precedence over the url input.",
      "x-ui-hidden": true,
    },
  },
  required: ["text"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    success: {
      type: "boolean",
      title: "Success",
      description: "True when Slack accepted the message",
    },
    status: {
      type: "number",
      title: "Status",
      description: "HTTP status code returned by Slack",
    },
  },
  required: ["success", "status"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type SlackNotifyTaskInput = FromSchema<typeof inputSchema>;
export type SlackNotifyTaskOutput = FromSchema<typeof outputSchema>;

/**
 * Posts a message to a Slack incoming webhook.
 *
 * Slack answers `200` with the body `ok` on success and a 4xx with a short
 * diagnostic body (`invalid_payload`, `no_service`) on failure; those bodies
 * carry no secrets, so they are surfaced in the error message. The webhook URL
 * carries the token and is never included.
 */
export class SlackNotifyTask<
  Input extends SlackNotifyTaskInput = SlackNotifyTaskInput,
  Output extends SlackNotifyTaskOutput = SlackNotifyTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  public static override readonly type = "SlackNotifyTask";
  public static override readonly category = "Notification";
  public static override title = "Slack Notify";
  public static override description = "Sends a message to a Slack incoming webhook";
  public static override cachePolicy: CachePolicy = { kind: "none" };
  public static override hasDynamicEntitlements: boolean = true;

  public static override entitlements(): TaskEntitlements {
    return webhookBaseEntitlements("Posts messages to a Slack incoming webhook over HTTPS");
  }

  public override entitlements(): TaskEntitlements {
    return webhookPrivateEntitlements(
      SlackNotifyTask.entitlements(),
      this.runInputData?.url,
      this.runInputData?.url_credential_key
    );
  }

  public static override inputSchema() {
    return inputSchema;
  }

  public static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, context: IExecuteContext): Promise<Output> {
    const url = resolveWebhookUrl(input.url, input.url_credential_key, "SlackNotifyTask");
    const result = await postWebhookJson({
      url,
      payload: compactPayload({
        text: input.text,
        blocks: input.blocks,
        username: input.username,
        icon_emoji: input.icon_emoji,
      }),
      headers: undefined,
      timeout: undefined,
      signal: context.signal,
      readSuccessBody: false,
      includeBodyInError: true,
      retryAfterFromJsonBody: false,
      label: "Slack webhook",
    });
    return { success: true, status: result.status } as Output;
  }
}

export const slackNotify = async (
  input: SlackNotifyTaskInput,
  config: TaskConfig = {}
): Promise<SlackNotifyTaskOutput> => {
  const result = await new SlackNotifyTask(config).run(input);
  return result as SlackNotifyTaskOutput;
};

declare module "@workglow/task-graph" {
  interface Workflow {
    slackNotify: CreateWorkflow<SlackNotifyTaskInput, SlackNotifyTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.slackNotify = CreateWorkflow(SlackNotifyTask);
