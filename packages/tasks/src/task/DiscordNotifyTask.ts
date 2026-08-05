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
        "Discord webhook URL. The token is part of the path, so it is treated as a secret and never echoed back.",
    },
    content: {
      type: "string",
      title: "Content",
      description: "Message content",
    },
    username: {
      type: "string",
      title: "Username",
      description: "Overrides the display name of the webhook",
    },
    avatar_url: {
      type: "string",
      format: "uri",
      title: "Avatar URL",
      description: "Overrides the avatar of the webhook",
    },
    embeds: {
      type: "array",
      items: { type: "object", additionalProperties: true },
      title: "Embeds",
      description: "Discord embed objects",
    },
    credential_key: {
      type: "string",
      format: "credential",
      title: "Credential Key",
      description:
        "Key to look up in the credential store. The resolved value is the webhook URL itself, and takes precedence over the url input.",
      "x-ui-hidden": true,
    },
  },
  required: ["content"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    success: {
      type: "boolean",
      title: "Success",
      description: "True when Discord accepted the message",
    },
    status: {
      type: "number",
      title: "Status",
      description: "HTTP status code returned by Discord, 204 on success",
    },
  },
  required: ["success", "status"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type DiscordNotifyTaskInput = FromSchema<typeof inputSchema>;
export type DiscordNotifyTaskOutput = FromSchema<typeof outputSchema>;

/**
 * Posts a message to a Discord webhook.
 *
 * A successful post answers `204 No Content`, so the success body is never
 * read. Rate limits arrive as `429` and may carry the delay as
 * `{"retry_after": <seconds>}` in the body rather than a `Retry-After` header,
 * so the body is consulted as a secondary retry source.
 */
export class DiscordNotifyTask<
  Input extends DiscordNotifyTaskInput = DiscordNotifyTaskInput,
  Output extends DiscordNotifyTaskOutput = DiscordNotifyTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  public static override readonly type = "DiscordNotifyTask";
  public static override readonly category = "Utility";
  public static override title = "Discord Notify";
  public static override description = "Sends a message to a Discord webhook";
  public static override cachePolicy: CachePolicy = { kind: "none" };
  public static override hasDynamicEntitlements: boolean = true;

  public static override entitlements(): TaskEntitlements {
    return webhookBaseEntitlements("Posts messages to a Discord webhook over HTTPS");
  }

  public override entitlements(): TaskEntitlements {
    return webhookPrivateEntitlements(
      DiscordNotifyTask.entitlements(),
      this.runInputData?.url,
      this.runInputData?.credential_key
    );
  }

  public static override inputSchema() {
    return inputSchema;
  }

  public static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, context: IExecuteContext): Promise<Output> {
    const url = resolveWebhookUrl(input.url, input.credential_key, "DiscordNotifyTask");
    const result = await postWebhookJson({
      url,
      payload: compactPayload({
        content: input.content,
        username: input.username,
        avatar_url: input.avatar_url,
        embeds: input.embeds,
      }),
      headers: undefined,
      timeout: undefined,
      signal: context.signal,
      readSuccessBody: false,
      includeBodyInError: true,
      retryAfterFromJsonBody: true,
      label: "Discord webhook",
    });
    return { success: true, status: result.status } as Output;
  }
}

export const discordNotify = async (
  input: DiscordNotifyTaskInput,
  config: TaskConfig = {}
): Promise<DiscordNotifyTaskOutput> => {
  const result = await new DiscordNotifyTask(config).run(input);
  return result as DiscordNotifyTaskOutput;
};

declare module "@workglow/task-graph" {
  interface Workflow {
    discordNotify: CreateWorkflow<DiscordNotifyTaskInput, DiscordNotifyTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.discordNotify = CreateWorkflow(DiscordNotifyTask);
