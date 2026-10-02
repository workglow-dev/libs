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
        "Slack Block Kit blocks. Channel-wide broadcasts are neutralized in every string inside the structure, the same as 'text', and rich_text broadcast/usergroup elements — which carry no escapable text — are rewritten to plain text, unless 'allow_mentions' is set. Masked links are reduced to their bare URL unless 'allow_markup' is set, in the <url|label> text form and in the structural form where an object pairs a destination with a label — 'url' beside 'text' (button, rich_text link, overflow option) and 'title_url' beside 'title' (video) — where the label is overwritten with the destination. An image block's 'image_url' is deliberately excluded: it is the picture, not a destination a caption can mask. A blocks leaf cannot be entity-escaped the way 'text' is, because the same walk visits url fields. Slack's two-field <!date^ts^format|fallback> token notifies nobody and survives by default; the four-field form carries a link and label of its own and is escaped.",
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
 * The one `<!…>` control sequence that is safe to leave live, matched by its
 * whole ARITY rather than by a prefix.
 *
 * Slack's date token is `<!date^ts^token_string^optional_link|fallback>`. In
 * the TWO-field form — `<!date^1700000000^{date_short}|Nov 14>` — the `|` part
 * is a fallback for clients that cannot render a date, and there is no
 * destination anywhere in it, so it can notify nobody and can phish nobody.
 * The FOUR-field form is a different animal: `token_string` is the rendered
 * label and `optional_link` is a URL, which is precisely the attacker-chosen
 * label over an attacker-chosen destination that {@link escapeSlackText} and
 * {@link stripSlackLinkLabels} exist to remove. A two-character `<!date^`
 * prefix cannot tell them apart, so the exemption is spelled out to the closing
 * `>`: `[^<>^|]*` on the third field admits no further `^`, so a token carrying
 * an `optional_link` fails to match and is escaped like any other broadcast.
 *
 * Everything about it fails closed. A case variant (`<!DATE^`), a non-numeric
 * timestamp, and a fallback containing a `<` all fail the match, so a token
 * whose shape cannot be fully verified is escaped WHOLE rather than exempted
 * with something unverified inside it.
 *
 * One source string, two regexes: the exemption has to mean the same thing in
 * the broadcast escape and in the delabeler, and each rule must be
 * independently correct because {@link stripSlackLinkLabels} is exported and
 * callable on its own.
 */
const SAFE_DATE_TOKEN = String.raw`!date\^\d+\^[^<>^|]*\|[^<>]*>`;

/**
 * A `<!` that opens a broadcast — every occurrence except a safe date token.
 *
 * `<!` is Slack's CONTROL-SEQUENCE sigil, not a broadcast sigil, and the
 * two-field date token is the one documented member of that family that can
 * notify nobody: it renders a localized date. Escaping it is pure collateral
 * damage — Slack un-escapes the entity for display, so the message shows the
 * raw token, and the only opt-out (`allow_mentions`) re-enables live
 * channel-wide pings in the same field.
 *
 * A `<!channel>` written inside a date token's fallback text is still escaped:
 * the fallback half admits no `<`, so such a token fails the exemption and is
 * escaped as a whole.
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
const BROADCAST_SIGIL = new RegExp(String.raw`<(?!${SAFE_DATE_TOKEN})!`, "g");

/**
 * A `<url|label>` sequence, excluding only a safe date token.
 *
 * {@link SAFE_DATE_TOKEN} is what the lookahead exempts, and nothing wider: a
 * four-field date token IS a `<…|…>` masking a destination, so exempting the
 * whole `<!…>` family here handed one straight through. Every other control
 * sequence is `<sigil…>` with no destination in it, so reducing it to its first
 * field changes nothing about what it does.
 *
 * `[^<>|]` on the URL half keeps a match inside ONE sequence — without it a
 * greedy run would span from one `<` past an intervening `>` to a later `|`,
 * swallowing whatever sat between two independent links.
 */
const MASKED_LINK = new RegExp(String.raw`<(?!${SAFE_DATE_TOKEN})([^<>|]*)\|[^<>]*>`, "g");

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
 * The (destination, label) property pairs Block Kit uses to express a masked
 * link structurally.
 *
 * An explicit table rather than "any `*_url` with a sibling label", and the
 * difference is not stylistic. An `image` block legitimately carries
 * `image_url` AND an optional `title`, so a wildcard would overwrite an
 * image's caption with its own CDN URL — a false positive in the commonest
 * block type there is. `image_url` is therefore deliberately absent: it is the
 * picture, not a destination a label can mask.
 *
 * Residual, accepted: a url/label pair Slack adds later is uncovered until it
 * joins this table. That is the price of not sweeping in `image_url`.
 */
const MASKED_LINK_PAIRS: ReadonlyArray<readonly [destination: string, label: string]> = [
  ["url", "text"],
  ["title_url", "title"],
];

/**
 * Overwrites `node[label]` with `url`, handling both shapes a Block Kit label
 * arrives in: a bare string, and a text composition (`{type, text}` — which is
 * what a `video` block's `plain_text` title and a button's label both are).
 *
 * Returns whether a label was found and rewritten, so the caller can tell
 * "masked link, handled" from "a bare destination with no label beside it".
 */
function overwriteLabel(node: Record<string, unknown>, label: string, url: string): boolean {
  const value = node[label];
  if (typeof value === "string") {
    node[label] = url;
    return true;
  }
  if (typeof value === "object" && value !== null) {
    const composition = value as Record<string, unknown>;
    if (typeof composition.text === "string") {
      composition.text = url;
      return true;
    }
  }
  return false;
}

/**
 * Reduces a Block Kit object that IS a link to its bare destination — the
 * structural twin of {@link stripSlackLinkLabels}' `<url|label>` → `<url>`.
 *
 * Block Kit says the same thing two ways, and only one of them has a `<` in it.
 * A button, a rich_text `link` element and an overflow `option` each carry a
 * `url` beside a label field, and a `video` block carries `title_url` beside a
 * required `title`, so a caller-supplied label masks a caller-supplied
 * destination with nothing for the lexical delabeler to match.
 *
 * Which property PAIRS count is enumerated in {@link MASKED_LINK_PAIRS};
 * within a pair the rule is still shape-driven, which is what reaches an
 * overflow `option` (it carries `url` + `text` and no `type` discriminator at
 * all, so no element-type set could).
 *
 * The destination is kept and the LABEL overwritten, never the reverse. A
 * button stripped of its `url`, with no live `action_id` handler behind it, is
 * an availability change — the same argument the broadcast rewrite makes for
 * rewriting rather than deleting. Accepted cost: a `title` overwritten with a
 * long `title_url` can exceed Slack's 200-character limit and draw
 * `invalid_blocks`, the same trade the button path already makes against its
 * 75-character `text` limit.
 *
 * A destination with no label beside it is already unmasked and is left alone,
 * with one exception: the rich_text `date` element, whose label comes from its
 * `format`/`fallback` rather than from a label field. Its optional link is the
 * structural half of the four-field `<!date^ts^label^url|fallback>` token, and
 * a date renders perfectly well unlinked, so there the `url` is DELETED. That
 * deletion stays scoped to `url`: a `title_url` with no `title` is not a video
 * block, because Slack requires one.
 *
 * Mutates the node, which is always the fresh child map the walk just built —
 * the caller-supplied structure is never touched.
 */
function reduceStructuralLink(node: Record<string, unknown>): void {
  for (const [destination, label] of MASKED_LINK_PAIRS) {
    const url = node[destination];
    if (typeof url !== "string") continue;
    if (overwriteLabel(node, label, url)) return;
    if (destination === "url" && node.type === "date") {
      delete node.url;
      return;
    }
  }
}

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
 * 4. STRUCTURAL MARKUP — {@link reduceStructuralLink}, under the SAME
 *    `policy.stripLabels`, because Block Kit expresses a masked link
 *    structurally as well as lexically: a destination field beside a label
 *    field has no `<` for rule 3 to match. The two remedies are the same
 *    remedy — keep the destination, drop the label — so one flag governs both.
 *    Within a recognized property PAIR the rule is shape-driven, so it reaches
 *    an overflow `option` that carries no `type` discriminator at all.
 *
 *    Residuals, all accepted: a url/label pair Slack adds later is uncovered
 *    until it joins {@link MASKED_LINK_PAIRS}, which is the price of not
 *    sweeping in `image_url` (an `image` block legitimately pairs it with a
 *    `title`, so a wildcard would rewrite a caption to its own CDN URL). And a
 *    `video` block additionally requires `links.embed:write` plus a registered
 *    unfurl domain, so an incoming webhook may be rejected with
 *    `invalid_blocks` before the pair ever renders — unverified either way, and
 *    not a reason to leave the shape uncovered.
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
    if (policy.stripLabels) reduceStructuralLink(escaped);
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
      // This task's payload shape carries no caller headers, so the URL is the
      // only secret in the post.
      secrets: undefined,
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
