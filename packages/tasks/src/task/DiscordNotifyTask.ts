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
  MAX_REQUEST_TIMEOUT_MS,
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
        "Discord webhook URL. The token is part of the path, so it is kept out of errors and output — but a value set here is stored verbatim in the graph JSON. Use 'url_credential_key' to keep the secret out of the saved workflow.",
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
    allow_mentions: {
      type: "boolean",
      default: false,
      title: "Allow Mentions",
      description:
        "Let the message ping. By default `allowed_mentions: { parse: [] }` is sent, suppressing @everyone/@here, role and user pings so piped or model-generated content cannot notify a whole server.",
    },
    timeout: {
      type: "integer",
      default: 30000,
      minimum: 1,
      maximum: MAX_REQUEST_TIMEOUT_MS,
      title: "Timeout",
      description:
        "Request timeout in milliseconds, a whole number no greater than 2147483647 (~24.8 days). There is no 'wait forever' setting: a black-holed endpoint would pin the task until the caller aborts, and a larger value would silently fire after 1 ms.",
    },
    allow_private_destination: {
      type: "boolean",
      default: false,
      title: "Allow Private Destination",
      description:
        "Permit posting to a private/internal/loopback destination — including a public-looking hostname that resolves into private address space. Requires the `network:private` entitlement, re-checked at execute time against the URL actually resolved. A destination whose URL does not already read as private additionally requires a registered entitlement enforcer to grant it. A declared private destination's reply body and reason phrase are never surfaced.",
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
  required: ["content"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    success: {
      type: "boolean",
      title: "Success",
      description: "Always true; a non-2xx response throws.",
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
  public static override readonly category = "Notification";
  public static override title = "Discord Notify";
  public static override description = "Sends a message to a Discord webhook";
  public static override cachePolicy: CachePolicy = { kind: "none" };
  public static override hasDynamicEntitlements: boolean = true;

  public static override entitlements(): TaskEntitlements {
    return webhookBaseEntitlements("Posts messages to a Discord webhook over HTTPS");
  }

  public override entitlements(): TaskEntitlements {
    return webhookPrivateEntitlements({
      base: DiscordNotifyTask.entitlements(),
      url: this.runInputData?.url,
      urlCredentialKey: this.runInputData?.url_credential_key,
      // Discord's payload shape is fixed and carries no caller headers, so
      // there is no header credential to declare.
      headerCredentialKey: undefined,
      allowPrivate: this.runInputData?.allow_private_destination,
    });
  }

  public static override inputSchema() {
    return inputSchema;
  }

  public static override outputSchema() {
    return outputSchema;
  }

  override async execute(input: Input, context: IExecuteContext): Promise<Output> {
    const url = resolveWebhookUrl(
      input.url,
      input.url_credential_key,
      Object.hasOwn(input, "url_credential_key"),
      "DiscordNotifyTask"
    );
    const result = await postWebhookJson({
      url,
      payload: compactPayload({
        content: input.content,
        username: input.username,
        avatar_url: input.avatar_url,
        embeds: input.embeds,
        // `parse: []` suppresses @everyone/@here plus every role and user
        // mention, so content piped in from a fetch or a model cannot turn a
        // notification into a server-wide ping (and a retry loop into an
        // amplifier). Opt back in with `allow_mentions`.
        allowed_mentions: input.allow_mentions === true ? undefined : { parse: [] },
      }),
      headers: undefined,
      // This task's payload shape carries no caller headers, so the URL is the
      // only secret in the post.
      secrets: undefined,
      timeout: input.timeout,
      signal: context.signal,
      registry: context.registry,
      readSuccessBody: false,
      includeBodyInError: true,
      retryAfterFromJsonBody: true,
      allowPrivateDestination: input.allow_private_destination === true,
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
