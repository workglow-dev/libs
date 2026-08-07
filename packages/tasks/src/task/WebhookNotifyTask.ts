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
import { classifyUrl } from "../util/UrlClassifier";
import {
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
      title: "URL",
      description:
        "Webhook endpoint to POST to. Kept out of errors and output — but a value set here is stored verbatim in the graph JSON. Use 'url_credential_key' to keep the secret out of the saved workflow.",
    },
    payload: {
      type: "object",
      additionalProperties: true,
      title: "Payload",
      description: "JSON body to send",
    },
    headers: {
      type: "object",
      additionalProperties: { type: "string" },
      title: "Headers",
      description: "Additional headers merged over the JSON content type",
    },
    timeout: {
      type: "number",
      default: 30000,
      title: "Timeout",
      description: "Request timeout in milliseconds",
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
  required: ["payload"],
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
      description: "HTTP status code returned by the endpoint",
    },
    response: {
      type: "string",
      title: "Response",
      description:
        "Response body, truncated to 1KB. Always empty for a private/internal destination, which is reachable but never echoed back.",
    },
  },
  required: ["success", "status", "response"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type WebhookNotifyTaskInput = FromSchema<typeof inputSchema>;
export type WebhookNotifyTaskOutput = FromSchema<typeof outputSchema>;

/**
 * Posts an arbitrary JSON payload to a webhook endpoint.
 *
 * The URL is handled as a secret: it is kept out of the output schema, and
 * failures report only the endpoint's origin.
 */
export class WebhookNotifyTask<
  Input extends WebhookNotifyTaskInput = WebhookNotifyTaskInput,
  Output extends WebhookNotifyTaskOutput = WebhookNotifyTaskOutput,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  public static override readonly type = "WebhookNotifyTask";
  public static override readonly category = "Notification";
  public static override title = "Webhook Notify";
  public static override description = "Sends a JSON payload to a webhook endpoint via HTTP POST";
  public static override cachePolicy: CachePolicy = { kind: "none" };
  public static override hasDynamicEntitlements: boolean = true;

  public static override entitlements(): TaskEntitlements {
    return webhookBaseEntitlements("Posts notifications to a webhook endpoint over HTTP/HTTPS");
  }

  public override entitlements(): TaskEntitlements {
    return webhookPrivateEntitlements(
      WebhookNotifyTask.entitlements(),
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
    const url = resolveWebhookUrl(input.url, input.url_credential_key, "WebhookNotifyTask");
    // Reachability of a private destination matches FetchUrlTask (gated by the
    // `network:private` entitlement), but the `response` port would additionally
    // turn this task into an SSRF *read* primitive: a POST to
    // http://169.254.169.254/latest/meta-data/iam/security-credentials/ would
    // hand a kilobyte of the reply back into the graph. Notification needs no
    // reply body, so the private path never reads one.
    const isPrivate = classifyUrl(url).kind === "private";
    const result = await postWebhookJson({
      url,
      payload: input.payload,
      headers: input.headers,
      timeout: input.timeout,
      signal: context.signal,
      readSuccessBody: !isPrivate,
      includeBodyInError: false,
      retryAfterFromJsonBody: false,
      label: "webhook",
    });
    return {
      success: true,
      status: result.status,
      response: isPrivate ? "" : result.body,
    } as Output;
  }
}

export const webhookNotify = async (
  input: WebhookNotifyTaskInput,
  config: TaskConfig = {}
): Promise<WebhookNotifyTaskOutput> => {
  const result = await new WebhookNotifyTask(config).run(input);
  return result as WebhookNotifyTaskOutput;
};

declare module "@workglow/task-graph" {
  interface Workflow {
    webhookNotify: CreateWorkflow<WebhookNotifyTaskInput, WebhookNotifyTaskOutput, TaskConfig>;
  }
}

Workflow.prototype.webhookNotify = CreateWorkflow(WebhookNotifyTask);
