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
  MAX_REQUEST_TIMEOUT_MS,
  postWebhookJson,
  resolveWebhookCredential,
  resolveWebhookUrl,
  webhookBaseEntitlements,
  webhookPrivateEntitlements,
} from "../util/WebhookPost";
import { applyCredentialToHeaders } from "./FetchUrlCredentials";
import { createFetchUrlJobError, FetchUrlErrorCode } from "./FetchUrlJobError";

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
      description:
        "Additional headers merged over the JSON content type. A value set here is stored verbatim in the graph JSON, so an authentication or signing secret belongs in 'credential_key' instead. A name that is not a bare header token, or a value carrying a NUL/CR/LF, is a permanent configuration error.",
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
      title: "Webhook URL Credential Key",
      description:
        "Key to look up in the credential store. The resolved value is the entire webhook URL — the secret itself, not a bearer token — and takes precedence over the url input.",
      "x-ui-hidden": true,
    },
    credential_key: {
      type: "string",
      format: "credential",
      title: "Header Credential Key",
      description:
        "Key to look up in the credential store. The resolved secret is placed on the request according to credential_scheme.",
      "x-ui-hidden": true,
    },
    credential_scheme: {
      enum: ["bearer", "basic", "header", "none"],
      title: "Credential Scheme",
      description:
        "How the resolved credential is sent. 'bearer' and 'basic' use the Authorization header ('basic' expects an already base64-encoded user:pass); 'header' uses credential_header; 'none' resolves but sends nothing.",
      default: "bearer",
      "x-ui-hidden": true,
    },
    credential_header: {
      type: "string",
      title: "Credential Header",
      description:
        "Header name used when credential_scheme is 'header'. Must be a bare header token (letters, digits, hyphens).",
      default: "Authorization",
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
 *
 * Two independent credential seams, because a generic webhook has two shapes of
 * secret and `Task.toJSON` serializes `defaults` verbatim into the saved graph:
 *
 * - `url_credential_key` — the resolved value IS the whole endpoint, the
 *   Slack/Discord shape where the token lives in the path;
 * - `credential_key` (+ `credential_scheme` / `credential_header`) — a bearer
 *   token, basic pair, or signing key placed on a REQUEST HEADER, which is what
 *   an authenticated or HMAC-signed endpoint needs. Without it such a secret had
 *   to be inlined in the `headers` port and would be written into the graph JSON.
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
    return webhookPrivateEntitlements({
      base: WebhookNotifyTask.entitlements(),
      url: this.runInputData?.url,
      urlCredentialKey: this.runInputData?.url_credential_key,
      headerCredentialKey: this.runInputData?.credential_key,
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
      "WebhookNotifyTask"
    );
    // Placed FIRST, so the header the credential produces is validated by
    // `postWebhookJson`'s own header guard like any caller-supplied one — a
    // secret carrying a stray newline is a configuration error, not a request
    // undici rejects with a `TypeError` that quotes the secret back.
    //
    // No credential-port stripping here, unlike `FetchUrlTask`: that task
    // forwards `...rest` into a job input, so a resolved secret left on a port
    // would be persisted. This post is assembled field by field below and the
    // credential ports are simply never read again.
    //
    // Checked BEFORE the credential is applied: `applyCredentialToHeaders`
    // fails OPEN on a missing value — it returns the caller's headers
    // unchanged — so without this guard a locked store or a mistyped key posts
    // the notification unauthenticated and reports success. `Object.hasOwn` is
    // the discriminator because the input resolver writes `undefined` over a
    // missed key, leaving the port present.
    const credential = resolveWebhookCredential(
      input.credential_key,
      Object.hasOwn(input, "credential_key"),
      "credential_key",
      "WebhookNotifyTask"
    );
    let headers: Record<string, string> | undefined;
    try {
      headers = applyCredentialToHeaders({
        headers: input.headers,
        credential,
        scheme: input.credential_scheme,
        headerName: input.credential_header,
      });
    } catch (err) {
      // `credentialHeaderName` throws a `TaskConfigurationError` whose message is
      // hardcoded "FetchUrlTask: …" and which carries no `FETCH_*` code, so a
      // queued consumer could not classify it. Re-raised under this task's own
      // label as a permanent CONFIGURATION failure. Only the header NAME appears
      // in that message; the credential value never does.
      const detail = err instanceof Error ? err.message : String(err);
      throw createFetchUrlJobError(
        FetchUrlErrorCode.CONFIGURATION,
        `WebhookNotifyTask: ${detail.replace(/^FetchUrlTask: /, "")}`
      );
    }

    const result = await postWebhookJson({
      url,
      payload: input.payload,
      headers,
      // The port holds the RESOLVED secret by execute time, so this is the
      // value an echoing endpoint would hand back into `response`. Redacted
      // unconditionally, including under `credential_scheme: "none"`: a value
      // that is never sent cannot be echoed, so redacting it costs nothing and
      // keeps a scheme-dependent branch out of a security path.
      secrets: input.credential_key === undefined ? [] : [input.credential_key],
      timeout: input.timeout,
      signal: context.signal,
      registry: context.registry,
      // A ceiling, not the decision: `postWebhookJson` forces this to `false`
      // for a DECLARED private destination and is the single decider, because
      // the `response` port would otherwise turn this task into an SSRF *read*
      // primitive — a POST to
      // http://169.254.169.254/latest/meta-data/iam/security-credentials/ would
      // hand a kilobyte of the reply back into the graph. Classifying the URL a
      // second time here is how the two halves drift apart.
      readSuccessBody: true,
      includeBodyInError: false,
      retryAfterFromJsonBody: false,
      allowPrivateDestination: input.allow_private_destination === true,
      label: "webhook",
    });
    return {
      success: true,
      status: result.status,
      response: result.body,
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
