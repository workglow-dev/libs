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
import { SECURITY_LIMITS } from "@workglow/util";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";
import {
  compactPayload,
  postWebhookJson,
  resolveWebhookUrl,
  webhookBaseEntitlements,
  webhookPrivateEntitlements,
} from "../util/WebhookPost";
import { createFetchUrlJobError, FetchUrlErrorCode } from "./FetchUrlJobError";

const inputSchema = {
  type: "object",
  properties: {
    url: {
      type: "string",
      format: "uri",
      title: "Webhook URL",
      description:
        "Slack incoming webhook URL. The token is part of the path, so it is kept out of errors and output — but a value set here is stored verbatim in the graph JSON. Use 'url_credential_key' to keep the secret out of the saved workflow.",
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
      description:
        "Slack Block Kit blocks. Channel-wide broadcasts are neutralized in every string inside the structure, the same as 'text', unless 'allow_mentions' is set.",
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
    allow_mentions: {
      type: "boolean",
      default: false,
      title: "Allow Mentions",
      description:
        "Send 'text' and 'blocks' unmodified. By default channel-wide broadcasts (<!channel>, <!here>, <!everyone>, <!subteam^ID>) are neutralized in both so piped or model-generated content cannot notify a whole workspace.",
    },
    timeout: {
      type: "number",
      default: 30000,
      minimum: 1,
      title: "Timeout",
      description:
        "Request timeout in milliseconds. There is no 'wait forever' setting: a black-holed endpoint would pin the task until the caller aborts.",
    },
    allow_private_destination: {
      type: "boolean",
      default: false,
      title: "Allow Private Destination",
      description:
        "Permit posting to a private/internal/loopback destination. Requires the `network:private` entitlement.",
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
      description: "Always true; a non-2xx response throws.",
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
 * Defuses Slack's channel-wide broadcast sequences in caller-supplied text.
 *
 * Slack has no `allowed_mentions` equivalent; its documented control is
 * HTML-entity escaping. Broadcasts are all written `<!…>` — `<!channel>`,
 * `<!here>`, `<!everyone>` and the group form `<!subteam^ID>` — so escaping
 * just the opening `<!` kills every one of them while leaving `<https://…|label>`
 * links and single-user `<@U123>` mentions intact, which full `<`/`>` escaping
 * would break.
 *
 * `link_names` is NOT a substitute: it governs auto-linking of bare `@name`
 * text, not these control sequences.
 */
export function neutralizeSlackBroadcasts(text: string): string {
  return text.split("<!").join("&lt;!");
}

/**
 * Applies {@link neutralizeSlackBroadcasts} to every string inside a Block Kit
 * structure, so `text` and `blocks` share one escape rule rather than two.
 *
 * EVERY string leaf is escaped, not just the ones that render as message body.
 * `<!` is a broadcast sigil wherever Slack finds it and has no legitimate
 * occurrence in a `type`, `block_id`, `action_id` or URL field, so escaping all
 * of them is complete and side-effect-free — it covers `fields[]`,
 * `elements[]`, accessories and header/context blocks without enumerating them,
 * and cannot miss a block shape Slack adds later.
 *
 * New structures are returned; the input may be edge-owned and is never
 * mutated. Depth is capped rather than cycle-tracked: a cycle is infinitely
 * deep, so the cap terminates it, and the permanent configuration error that
 * results is exactly what a cyclic payload already produces a moment later when
 * the request body is serialized.
 */
export function neutralizeSlackBroadcastsDeep(value: unknown, depth: number = 0): unknown {
  if (depth > SECURITY_LIMITS.slackBlocksMaxDepth) {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.CONFIGURATION,
      `SlackNotifyTask: 'blocks' nests deeper than ${SECURITY_LIMITS.slackBlocksMaxDepth} levels or contains a cycle.`
    );
  }
  if (typeof value === "string") {
    return neutralizeSlackBroadcasts(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => neutralizeSlackBroadcastsDeep(entry, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const escaped: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      escaped[key] = neutralizeSlackBroadcastsDeep(entry, depth + 1);
    }
    return escaped;
  }
  return value;
}

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
      this.runInputData?.url_credential_key,
      this.runInputData?.allow_private_destination
    );
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
      "SlackNotifyTask"
    );
    const allowMentions = input.allow_mentions === true;
    const result = await postWebhookJson({
      url,
      payload: compactPayload({
        text: allowMentions ? input.text : (neutralizeSlackBroadcastsDeep(input.text) as string),
        blocks: allowMentions ? input.blocks : neutralizeSlackBroadcastsDeep(input.blocks),
        username: input.username,
        icon_emoji: input.icon_emoji,
        link_names: allowMentions ? undefined : false,
      }),
      headers: undefined,
      timeout: input.timeout,
      signal: context.signal,
      readSuccessBody: false,
      includeBodyInError: true,
      retryAfterFromJsonBody: false,
      allowPrivateDestination: input.allow_private_destination === true,
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
