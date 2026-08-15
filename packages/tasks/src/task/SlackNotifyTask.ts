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
  MAX_REQUEST_TIMEOUT_MS,
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
      description:
        "Message text, also used as the notification fallback for block messages. Slack markup is escaped by default, so links, mentions and the <!date^...> token render as literal text; set 'allow_markup' to send them live.",
    },
    blocks: {
      type: "array",
      items: { type: "object", additionalProperties: true },
      title: "Blocks",
      description:
        "Slack Block Kit blocks. Channel-wide broadcasts are neutralized in every string inside the structure, the same as 'text', and rich_text broadcast/usergroup elements — which carry no escapable text — are rewritten to plain text, unless 'allow_mentions' is set. Masked links (<url|label>) are reduced to their bare URL unless 'allow_markup' is set — a blocks leaf cannot be entity-escaped the way 'text' is, because the same walk visits url fields. Slack's <!date^...> formatting token notifies nobody and survives by default.",
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
        "Send 'text' and 'blocks' unmodified, and implies 'allow_markup'. By default channel-wide broadcasts are neutralized in both — the text forms (<!channel>, <!here>, <!everyone>, <!subteam^ID>) by escaping, and the rich_text broadcast/usergroup element shapes by rewriting — so piped or model-generated content cannot notify a whole workspace. Also governs 'username' and 'icon_emoji', which get the broadcast escape only.",
    },
    allow_markup: {
      type: "boolean",
      default: false,
      title: "Allow Markup",
      description:
        "Send Slack markup live: <url|label> links, single-user <@U123> mentions and the <!date^...> token. By default 'text' is HTML-entity escaped and masked links inside 'blocks' are reduced to their bare URL, so piped or model-generated content cannot render an attacker-chosen label over an attacker-chosen URL. Channel-wide broadcasts are still neutralized — that needs 'allow_mentions', which implies this setting.",
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
        "Permit posting to a private/internal/loopback destination — including a public-looking hostname that resolves into private address space. Requires the `network:private` entitlement, re-checked at execute time against the URL actually resolved. A declared private destination's reply body and reason phrase are never surfaced.",
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
 * A `<!` that opens a broadcast — every occurrence except the date token.
 *
 * `<!` is Slack's CONTROL-SEQUENCE sigil, not a broadcast sigil, and
 * `<!date^1700000000^{date_short}|Nov 14>` is the one documented member of
 * that family that can notify nobody: it renders a localized date. Escaping it
 * is pure collateral damage — Slack un-escapes the entity for display, so the
 * message shows the raw token, and the only opt-out (`allow_mentions`)
 * re-enables live channel-wide pings in the same field.
 *
 * The exemption is an exact lowercase prefix matched at the `<!` itself: a
 * `<!channel>` written inside a date token's fallback text is still escaped,
 * and a case variant (`<!DATE^`) is escaped too — whether Slack accepts one is
 * unverified, so this fails closed.
 *
 * With the exemption in place, everything this escape still removes
 * (`<!channel>`, `<!here>`, `<!everyone>`, `<!subteam^…>`) IS a mention, so
 * `allow_mentions` governs a single concern: this lexical escape, the structural
 * broadcast/usergroup rewrite and `link_names: false` all belong to it.
 *
 * MARKUP is a second, genuinely different concern, and it does have behavior
 * behind it — {@link escapeSlackText} and {@link stripSlackLinkLabels}, under
 * the separate `allow_markup` port. Wanting a build link in a notification is
 * orthogonal to wanting `@channel` to ping four hundred people, so one control
 * cannot serve both. `allow_mentions` implies `allow_markup`: live mentions
 * without live markup is not a state anyone asks for.
 */
const BROADCAST_SIGIL = /<!(?!date\^)/g;

/**
 * A `<url|label>` sequence, excluding the `<!…>` control family.
 *
 * `(?!!)` is what exempts `<!date^1700000000^{date_short}|Nov 14>`: the `|`
 * part of a date token is a FALLBACK for clients that cannot render the date,
 * not a label masking a destination, and the same exemption covers any other
 * `<!…>` control sequence the broadcast escape has already dealt with.
 *
 * `[^<>|]` on the URL half keeps a match inside ONE sequence — without it a
 * greedy run would span from one `<` past an intervening `>` to a later `|`,
 * swallowing whatever sat between two independent links.
 */
const MASKED_LINK = /<(?!!)([^<>|]*)\|[^<>]*>/g;

/**
 * HTML-entity escapes Slack's three active characters.
 *
 * `&` MUST be replaced first: doing it after `<`/`>` would re-escape the
 * ampersands those two just introduced, so `<c>` would arrive as
 * `&amp;lt;c&amp;gt;` and render as the literal text `&lt;c&gt;`.
 *
 * This is Slack's own documented escaping rule, and it is total — every link,
 * mention and control sequence in the escaped text renders as literal
 * characters. That is the point: an attacker-chosen label over an
 * attacker-chosen URL is a phishing primitive, and a notification body assembled
 * from a fetch result or a model summary is exactly where one arrives. The
 * message stays perfectly readable; only clickability is lost.
 */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Reduces `<url|label>` to `<url>`, so a link renders as its real destination.
 *
 * The weaker of the two markup controls, and the one `blocks` gets: full
 * entity escaping CANNOT be applied there. {@link neutralizeSlackBroadcastsDeep}
 * is shape-agnostic by design — it visits `url`, `image_url`, `value` and
 * `action_id` leaves as readily as `text` ones — and escaping `&` in a `url`
 * leaf corrupts every query string it touches (`?a=1&b=2` becomes `?a=1&amp;b=2`).
 * `<!` is safe to escape everywhere precisely because it has no legitimate
 * occurrence in those fields; `&` does. So `text` and `blocks` need different
 * policies, and this is the blocks half.
 *
 * What survives: the label is dropped, so the reader sees where the link
 * actually goes. What does not: a bare `<https://evil.example>` is still a live
 * link, and `<@U123>` still resolves. Stated in the README as the residual.
 */
export function stripSlackLinkLabels(text: string): string {
  return text.replace(MASKED_LINK, "<$1>");
}

/** How {@link neutralizeSlackBroadcastsDeep} treats markup it finds in a leaf. */
export interface SlackDeepEscapePolicy {
  /** Reduce `<url|label>` to `<url>` in every string leaf. */
  readonly stripLabels: boolean;
}

/**
 * Defuses Slack's channel-wide broadcast sequences in caller-supplied text.
 *
 * Slack has no `allowed_mentions` equivalent; its documented control is
 * HTML-entity escaping. In message TEXT every broadcast is written `<!…>` —
 * `<!channel>`, `<!here>`, `<!everyone>` and the group form `<!subteam^ID>` —
 * so escaping just the opening `<!` kills every one of them while leaving
 * `<https://…|label>` links, single-user `<@U123>` mentions and the
 * `<!date^…>` formatting token intact, which full `<`/`>` escaping would break.
 * The date token is exempted by {@link BROADCAST_SIGIL}, which explains why.
 *
 * Text is not the only form: Block Kit `rich_text` expresses the same ping
 * structurally, with no `<!` to escape. That half is handled by
 * {@link neutralizeSlackBroadcastsDeep}.
 *
 * `link_names` is NOT a substitute: it governs auto-linking of bare `@name`
 * text, not these control sequences.
 */
export function neutralizeSlackBroadcasts(text: string): string {
  return text.replace(BROADCAST_SIGIL, "&lt;!");
}

/**
 * Block Kit element types that ARE a broadcast, rather than containing one as
 * text. Slack renders these from their shape — no `<!` sigil is involved — so
 * the lexical escape cannot see them.
 */
const STRUCTURAL_BROADCAST_TYPES: ReadonlySet<string> = new Set(["broadcast", "usergroup"]);

/**
 * Neutralizes channel-wide broadcasts inside a Block Kit structure, so `text`
 * and `blocks` share one rule rather than two.
 *
 * Two mechanisms, because Slack has two ways to say the same thing.
 *
 * 1. LEXICAL — {@link neutralizeSlackBroadcasts} on EVERY string leaf, not just
 *    the ones that render as message body. A non-date `<!` is a broadcast sigil
 *    wherever Slack finds it and has no legitimate occurrence in a `type`,
 *    `block_id`, `action_id` or URL field, so escaping all of them is
 *    side-effect-free — it covers `fields[]`, `elements[]`, accessories and
 *    header/context blocks without enumerating them, and cannot miss a block
 *    SHAPE Slack adds later. Calling that one function is also what carries the
 *    date-token exemption to every leaf, rather than a second copy of the rule.
 *
 * 2. STRUCTURAL — a `rich_text` message says `@channel` with
 *    `{type: "broadcast", range: "channel"}` and a group ping with
 *    `{type: "usergroup", usergroup_id: "S…"}`. There is no `<!` anywhere in
 *    either, so escaping string leaves leaves both fully live. Such an element
 *    is REWRITTEN to a plain text node rather than deleted: dropping it can
 *    leave an `elements[]` empty, which Slack rejects — turning a security
 *    control into an availability bug. The replacement text is literal
 *    (`@channel`), and `link_names: false` is already sent whenever mentions are
 *    disallowed, so it cannot auto-link.
 *
 * Matching on `type` alone rather than on `rich_text` ancestry is deliberate:
 * the only false positive is a caller who wanted a live usergroup ping, which is
 * exactly what this control exists to stop.
 *
 * Residual: a NEW structural notification element type Slack introduces later is
 * uncovered until it is added to {@link STRUCTURAL_BROADCAST_TYPES}. Unlike the
 * lexical half, this one cannot be shape-agnostic — a structural broadcast is
 * identified by nothing but its type name.
 *
 * 3. MARKUP — {@link stripSlackLinkLabels}, under `policy.stripLabels`. This one
 *    is a POLICY rather than an unconditional rule because it is the weaker
 *    remedy chosen for this walk specifically: `text` gets full entity escaping
 *    and `blocks` cannot, since the same traversal that reaches a `text` leaf
 *    also reaches a `url` leaf, where escaping `&` would corrupt a query string.
 *    The policy is required at every call site rather than defaulted — which of
 *    the two markup regimes a payload is under is exactly the thing a reader
 *    needs to see at the call.
 *
 * Order within a leaf: the broadcast escape runs FIRST. Reversed, a masked link
 * whose label contains a broadcast (`<https://x/|<!channel>>`) survives —
 * `MASKED_LINK` cannot match across the inner `<`, so nothing is stripped, and
 * the label is then merely escaped and left in place as a live link.
 *
 * New structures are returned; the input may be edge-owned and is never
 * mutated. Depth is capped rather than cycle-tracked: a cycle is infinitely
 * deep, so the cap terminates it, and the permanent configuration error that
 * results is exactly what a cyclic payload already produces a moment later when
 * the request body is serialized.
 */
export function neutralizeSlackBroadcastsDeep(
  value: unknown,
  policy: SlackDeepEscapePolicy,
  depth: number = 0
): unknown {
  if (depth > SECURITY_LIMITS.slackBlocksMaxDepth) {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.CONFIGURATION,
      `SlackNotifyTask: 'blocks' nests deeper than ${SECURITY_LIMITS.slackBlocksMaxDepth} levels or contains a cycle.`
    );
  }
  if (typeof value === "string") {
    const escaped = neutralizeSlackBroadcasts(value);
    return policy.stripLabels ? stripSlackLinkLabels(escaped) : escaped;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => neutralizeSlackBroadcastsDeep(entry, policy, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const elementType = (value as { readonly type?: unknown }).type;
    if (typeof elementType === "string" && STRUCTURAL_BROADCAST_TYPES.has(elementType)) {
      const range = (value as { readonly range?: unknown }).range;
      // `range` is caller-supplied and this is the one string leaf the
      // traversal builds rather than visits, so it would otherwise be the
      // single value in the whole payload that skips the lexical escape — a
      // `range` of `x<!channel>y` would be handed back live inside the very
      // node written to neutralize a broadcast.
      return {
        type: "text",
        text: neutralizeSlackBroadcasts(
          elementType === "broadcast" && typeof range === "string" ? `@${range}` : `@${elementType}`
        ),
      };
    }
    const escaped: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      escaped[key] = neutralizeSlackBroadcastsDeep(entry, policy, depth + 1);
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
    return webhookPrivateEntitlements({
      base: SlackNotifyTask.entitlements(),
      url: this.runInputData?.url,
      urlCredentialKey: this.runInputData?.url_credential_key,
      // Slack's payload shape is fixed and carries no caller headers, so there
      // is no header credential to declare.
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
      "SlackNotifyTask"
    );
    const allowMentions = input.allow_mentions === true;
    // A three-rung ladder, and `allow_mentions` sits on the top rung of both:
    // live mentions with dead links is not a state anyone asks for, and a rung
    // nothing can reach is a rung that never gets tested.
    const allowMarkup = allowMentions || input.allow_markup === true;
    const result = await postWebhookJson({
      url,
      payload: compactPayload({
        // `text` gets the STRONG remedy — total entity escaping — because it is
        // a single message body with no url/action_id leaves hiding in it. The
        // weaker delabeling is what `blocks` has to settle for.
        text: allowMentions
          ? input.text
          : allowMarkup
            ? neutralizeSlackBroadcasts(input.text)
            : escapeSlackText(input.text),
        blocks: allowMentions
          ? input.blocks
          : neutralizeSlackBroadcastsDeep(input.blocks, { stripLabels: !allowMarkup }),
        // These two stay on the BROADCAST escape only, deliberately. Whether
        // Slack un-escapes entities in a display name is unverified, so
        // escaping here risks a literal `&amp;` in a bot name for no attested
        // gain — and neither field renders a link, so masked-link injection has
        // nowhere to land. Same footing as the note below: defence in depth,
        // NOT a closed bypass.
        //
        // Defence in depth, NOT a closed bypass: whether Slack parses
        // broadcast syntax inside a display name or an emoji code is
        // unconfirmed, so this is not evidence of a leak that was open. The
        // escape is free and side-effect-free on both fields, which is reason
        // enough not to leave the question standing.
        username: allowMentions
          ? input.username
          : (neutralizeSlackBroadcastsDeep(input.username, { stripLabels: false }) as
              string | undefined),
        icon_emoji: allowMentions
          ? input.icon_emoji
          : (neutralizeSlackBroadcastsDeep(input.icon_emoji, { stripLabels: false }) as
              string | undefined),
        link_names: allowMentions ? undefined : false,
      }),
      headers: undefined,
      timeout: input.timeout,
      signal: context.signal,
      registry: context.registry,
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
