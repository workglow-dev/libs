/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared JSON-POST plumbing for the webhook notification tasks.
 *
 * A Slack/Discord webhook URL *is* the credential — the token lives in the
 * path — so unlike {@link FetchUrlTask} (public URL plus a separate bearer
 * token) the URL must never reach an error message, task output, or log line.
 * Every message produced here is built from {@link redactWebhookUrl}, and any
 * error bubbling out of `safeFetch` (whose messages do embed the full URL) is
 * rewritten through {@link redactWebhookUrlIn} — message, `url` field AND
 * `stack` — before it escapes.
 *
 * `safeFetch`'s own messages are only "trusted non-secret" for callers whose
 * URL is not itself a credential (e.g. {@link FetchUrlTask}, where the URL is
 * the most useful diagnostic there is). This module is the one layer that
 * knows the URL IS the credential, so redaction belongs here rather than in
 * the shared transport.
 */

import { AbortSignalJobError } from "@workglow/job-queue";
import type { TaskEntitlements } from "@workglow/task-graph";
import { ENTITLEMENT_ENFORCER, Entitlements, mergeEntitlements } from "@workglow/task-graph";
import type { ServiceRegistry } from "@workglow/util";
import { SECURITY_LIMITS } from "@workglow/util";
import type { FetchUrlJobErrorInstance } from "../task/FetchUrlJobError";
import {
  createFetchUrlAbortedError,
  createFetchUrlJobError,
  FetchUrlErrorCode,
  httpStatusToFetchUrlErrorCode,
  isFetchUrlJobError,
} from "../task/FetchUrlJobError";
import { isSafeFetchRedirectError, safeFetch } from "./SafeFetch";
import { classifyUrl, urlResourcePattern } from "./UrlClassifier";

/** Placeholder used when a webhook URL cannot even be parsed for its origin. */
const REDACTED_URL = "<redacted-webhook-url>";

/** Placeholder substituted for a token-bearing fragment of a webhook URL. */
const REDACTED_SEGMENT = "<redacted>";

/** Maximum characters of a success body surfaced as task output. */
const MAX_RESPONSE_BODY_CHARS = 1024;

/** Maximum characters of a failure body surfaced in an error message. */
const MAX_ERROR_BODY_CHARS = 256;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/**
 * Reduces a webhook URL to its origin, dropping the path that carries the
 * token. Unparseable input collapses to a fixed placeholder rather than
 * echoing back whatever was passed in.
 */
export function redactWebhookUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return REDACTED_URL;
  }
}

/**
 * Strips every trace of `url` out of `text`.
 *
 * Matching the literal full URL alone is not enough: an endpoint routinely
 * echoes only PART of it. Express answers an unknown route with
 * `Cannot POST /services/T0.../SECRETTOKEN` — the path, never the origin — and
 * a validation error may quote the token on its own. So after the full URL
 * collapses to its origin (which stays the useful diagnostic), the path, the
 * query and each individual path segment are replaced too.
 *
 * Candidates are applied LONGEST FIRST: replacing a short segment first would
 * break a longer candidate that contains it, leaving the rest of that longer
 * fragment behind.
 *
 * A candidate is admitted only when it is long enough to plausibly be a token
 * AND is not an all-lowercase word. Both clauses are load-bearing: `services`
 * and `webhooks` are real segments of the Slack and Discord webhook paths, and
 * redacting them would corrupt ordinary prose like `invalid webhooks payload`
 * for no security gain.
 */
export function redactWebhookUrlIn(text: string, url: string): string {
  if (url.length === 0) {
    return text;
  }
  let redacted = text.split(url).join(redactWebhookUrl(url));

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return redacted;
  }

  const candidates = new Set<string>();
  const admit = (candidate: string): void => {
    if (
      candidate.length >= SECURITY_LIMITS.webhookMinRedactableSegmentChars &&
      !/^[a-z]+$/.test(candidate)
    ) {
      candidates.add(candidate);
    }
  };
  admit(`${parsed.pathname}${parsed.search}`);
  admit(parsed.search);
  for (const segment of parsed.pathname.split("/")) {
    admit(segment);
    const encoded = encodeURIComponent(segment);
    if (encoded !== segment) {
      admit(encoded);
    }
  }

  for (const candidate of [...candidates].sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(candidate).join(REDACTED_SEGMENT);
  }
  return redacted;
}

/**
 * Builds a redacted `.stack` for a rewritten error.
 *
 * `BaseError` never overrides `stack`, so V8 materializes it as
 * `"<name>: <message>\n    at …"` — the message is baked into the string.
 * Copying an unredacted stack across therefore re-imports the very webhook
 * token the rewrite just stripped from `.message` and `.url`, and stacks are
 * persisted (see `formatErrorChainForDiagnostics`), so "logs are trusted" is
 * not an available defence.
 *
 * The header is replaced wholesale rather than patched: a message may itself
 * contain newlines, so the split point is the first stack FRAME (`    at …`),
 * not the first line. Frames can embed the URL independently (a module
 * specifier, a fetch wrapper argument), so the assembled result gets a second
 * redaction pass.
 *
 * Fails CLOSED on runtimes whose stacks carry no `    at ` frames
 * (JavaScriptCore's `fn@file:line:col` form): only the redacted header is
 * kept, losing frames rather than risking the secret.
 */
export function redactedStackFrom(original: unknown, rebuilt: Error, url: string): string {
  const header = `${rebuilt.name}: ${rebuilt.message}`;
  const originalStack =
    original instanceof Error && typeof original.stack === "string" ? original.stack : "";
  const lines = originalStack.split("\n");
  const firstFrame = lines.findIndex((line) => /^\s+at /.test(line));
  if (firstFrame < 0) {
    return redactWebhookUrlIn(header, url);
  }
  return redactWebhookUrlIn([header, ...lines.slice(firstFrame)].join("\n"), url);
}

/**
 * Picks the webhook URL, preferring a resolved credential over the plain
 * `url` port. Credential values arrive already resolved by the input
 * resolver, so the key name never reaches the network.
 *
 * `credentialConfigured` says whether the task declared a key at all, which is
 * what separates "no credential wanted" from "credential wanted but the store
 * could not answer". The resolver overwrites the port in place, so by the time
 * `execute` runs the key itself is gone: a store miss leaves the port PRESENT
 * with value `undefined`, whereas an unconfigured port is absent entirely. A
 * miss must fail rather than fall back to `url` — otherwise a locked store or
 * a mistyped key silently redirects the notification to a different endpoint
 * and reports success.
 */
export function resolveWebhookUrl(
  url: string | undefined,
  credential: string | undefined,
  credentialConfigured: boolean,
  label: string
): string {
  if (credentialConfigured && (credential === undefined || credential.length === 0)) {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.CONFIGURATION,
      `${label}: 'url_credential_key' is set but the credential store returned no value for it. ` +
        `Unlock the store or correct the key; 'url' is not used as a fallback when a credential key is configured.`
    );
  }
  const resolved = credential !== undefined && credential.length > 0 ? credential : url;
  if (resolved === undefined || resolved.length === 0) {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.CONFIGURATION,
      `${label}: no webhook URL provided. Set the 'url' input or the 'url_credential_key' input.`
    );
  }
  // A bearer token wired into `url_credential_key` is the likely mistake here:
  // these tasks expect the credential to BE the whole webhook URL. Say so, but
  // never echo the value — it is a secret whichever kind it turns out to be.
  let protocol: string;
  try {
    protocol = new URL(resolved).protocol;
  } catch {
    protocol = "";
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.CONFIGURATION,
      `${label}: the resolved webhook value must be an absolute http(s) URL. ` +
        `If 'url_credential_key' holds a bearer token rather than a full webhook URL, use FetchUrlTask instead.`
    );
  }
  return resolved;
}

export interface WebhookPostRequest {
  /** Full webhook URL. Treated as a secret throughout. */
  readonly url: string;
  /** Value serialized as the JSON request body. */
  readonly payload: unknown;
  /** Extra request headers merged over the JSON content type. */
  readonly headers: Readonly<Record<string, string>> | undefined;
  /** Request timeout in milliseconds. */
  readonly timeout: number | undefined;
  readonly signal: AbortSignal;
  /**
   * Read and return the success body. Endpoints replying 204 pass `false`.
   *
   * A ceiling, not a switch: {@link postWebhookJson} forces it to `false` for a
   * private/internal destination, whose body is never surfaced.
   */
  readonly readSuccessBody: boolean;
  /**
   * Include a truncated failure body in the thrown error message.
   *
   * A ceiling, not a switch: {@link postWebhookJson} forces it to `false` for a
   * private/internal destination, whose body is never surfaced.
   */
  readonly includeBodyInError: boolean;
  /** Also read `retry_after` (seconds) from a JSON failure body. */
  readonly retryAfterFromJsonBody: boolean;
  /**
   * The caller declared a private/internal destination is intended.
   *
   * A declaration, not the authorization: it is what keeps the `allowPrivate`
   * flag handed to {@link safeFetch} from being self-derived from whatever the
   * URL happened to resolve to. The `network:private` grant is what authorizes
   * the post, and it is re-checked against the resolved URL via
   * {@link assertPrivateDestinationGranted}.
   */
  readonly allowPrivateDestination: boolean;
  /**
   * Registry the task is executing under. When it carries an
   * {@link ENTITLEMENT_ENFORCER}, a private destination must hold a
   * `network:private` grant for the URL actually resolved.
   */
  readonly registry: ServiceRegistry | undefined;
  /** Human-readable subject used in error messages, e.g. "Slack webhook". */
  readonly label: string;
}

export interface WebhookPostResult {
  readonly status: number;
  readonly body: string;
}

/**
 * Derives a retry date from a rate-limited response. The `Retry-After` header
 * is authoritative; Discord instead returns `{"retry_after": <seconds>}` in a
 * JSON body, which is consulted as a secondary source.
 */
function retryDateFromResponse(
  response: Response,
  bodyText: string,
  parseJsonBody: boolean
): Date | undefined {
  const header = response.headers.get("Retry-After");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) {
      return new Date(Date.now() + seconds * 1000);
    }
    const parsedDate = new Date(header);
    if (!isNaN(parsedDate.getTime()) && parsedDate > new Date()) {
      return parsedDate;
    }
  }

  if (!parseJsonBody || bodyText.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(bodyText) as { readonly retry_after?: unknown };
    const seconds = Number(parsed?.retry_after);
    if (Number.isFinite(seconds) && seconds > 0) {
      return new Date(Date.now() + seconds * 1000);
    }
  } catch {
    // A non-JSON failure body simply carries no retry hint.
  }
  return undefined;
}

function leaksUrl(error: FetchUrlJobErrorInstance, url: string): boolean {
  return error.message.includes(url) || error.url === url;
}

/**
 * Normalizes anything thrown while posting into a typed fetch error whose
 * message cannot contain the webhook secret. Already-typed errors keep their
 * code (and therefore their retryable/permanent classification) and are passed
 * through untouched unless they embed the URL.
 *
 * `callerSignal` is the task's own abort signal, kept separate from the
 * composed timeout signal so a cancellation can be told apart from a timeout.
 */
function toRedactedWebhookError(
  error: unknown,
  url: string,
  label: string,
  callerSignal: AbortSignal
): unknown {
  if (error instanceof AbortSignalJobError) {
    return error;
  }
  // `fetch` rejects an aborted or timed-out request with a DOMException, which
  // would otherwise fall through to the retryable NETWORK_ERROR below — making
  // a cancelled workflow look like a transient failure worth retrying.
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    if (callerSignal.aborted || name === "AbortError") {
      return createFetchUrlAbortedError();
    }
    // Only a timeout that the caller did not also abort is a transient failure.
    return createFetchUrlJobError(
      FetchUrlErrorCode.NETWORK_ERROR,
      `Timed out posting ${label} to ${redactWebhookUrl(url)}`,
      { url: redactWebhookUrl(url) }
    );
  }
  // Matched on the transport's exported discriminant, never on its wording: a
  // reworded message must not be able to demote this refusal into the
  // retryable NETWORK_ERROR branch below. Checked ahead of the general
  // `isFetchUrlJobError` pass-through so the refusal keeps this task's own
  // framing rather than the transport's.
  //
  // Built from scratch rather than rewritten: the transport's message embeds
  // the requested URL (the secret), and the `Location` it refused to follow is
  // never read at all, so neither can reach the caller.
  if (isSafeFetchRedirectError(error)) {
    return createFetchUrlJobError(
      FetchUrlErrorCode.INVALID_URL,
      `Refusing to post ${label} to ${redactWebhookUrl(url)}: the endpoint answered with a ` +
        `redirect. A webhook POST is never re-sent to another origin, because the payload ` +
        `and any credentials would go with it. Configure the final URL instead.`,
      { url: redactWebhookUrl(url) }
    );
  }
  if (isFetchUrlJobError(error)) {
    if (!leaksUrl(error, url)) {
      return error;
    }
    const rebuilt = createFetchUrlJobError(error.code, redactWebhookUrlIn(error.message, url), {
      url: redactWebhookUrl(url),
      httpStatus: error.httpStatus,
      httpStatusText: error.httpStatusText,
      retryDate: error.retryDate,
    });
    // Deliberately NOT copying `error.cause`: `formatErrorChainForDiagnostics`
    // walks the cause chain and pushes every link's `.message` + `.stack` into
    // a PERSISTED job-error string, which would re-import the unredacted URL
    // this rebuild just stripped. `createFetchUrlJobError` sets no cause today
    // and none must be added here.
    rebuilt.stack = redactedStackFrom(error, rebuilt, url);
    return rebuilt;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return createFetchUrlJobError(
    FetchUrlErrorCode.NETWORK_ERROR,
    `Network error posting ${label} to ${redactWebhookUrl(url)}: ${redactWebhookUrlIn(detail, url)}`,
    { url: redactWebhookUrl(url) }
  );
}

/**
 * Reads a response body with a hard byte ceiling.
 *
 * `response.text()` buffers the whole body before any truncation constant can
 * apply, so a hostile (or merely broken) endpoint answering with a multi-GB
 * body would OOM the runner — including on the failure path, which buffers
 * unconditionally for all three notification tasks. Streaming lets the read be
 * abandoned mid-body: once the cap is passed the reader is cancelled and
 * whatever arrived so far is returned.
 */
async function readBodyText(
  response: Response,
  maxBytes: number = SECURITY_LIMITS.webhookMaxResponseBodyBytes
): Promise<string> {
  const body = response.body;
  if (body === null || body === undefined || typeof body.getReader !== "function") {
    // A bodiless response (204) or a runtime without streaming support.
    try {
      return await response.text();
    } catch {
      return "";
    }
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return text + decoder.decode();
      }
      if (value === undefined) {
        continue;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= maxBytes) {
        await reader.cancel().catch(() => {});
        // Flush the decoder here too: abandoning the read mid-body can leave a
        // partial multi-byte sequence buffered, which is dropped otherwise.
        return text + decoder.decode();
      }
    }
  } catch {
    return text;
  }
}

/**
 * Re-checks the `network:private` grant against the URL actually resolved.
 *
 * `allow_private_destination` is an input, and a graph root task's inputs are
 * applied AFTER the runner evaluates entitlements — so the declaration the
 * enforcer graded need not be the one `execute()` receives, and a
 * credential-backed URL does not exist yet at that point either. The
 * declaration is therefore advisory; this is the check that binds.
 *
 * No enforcer registered means no policy to satisfy, and the post proceeds.
 */
export async function assertPrivateDestinationGranted(
  registry: ServiceRegistry | undefined,
  url: string,
  label: string
): Promise<void> {
  if (registry === undefined || !registry.has(ENTITLEMENT_ENFORCER)) {
    return;
  }
  const denied = await registry.get(ENTITLEMENT_ENFORCER).checkAll({
    entitlements: [
      {
        id: Entitlements.NETWORK_PRIVATE,
        reason: `Posts ${label} to a private/internal destination`,
        resources: [urlResourcePattern(url)],
      },
    ],
  });
  if (denied.length > 0) {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.PRIVATE_DENIED,
      `Refusing to post ${label} to a private/internal destination: the 'network:private' ` +
        `entitlement is not granted for it.`,
      { url: redactWebhookUrl(url) }
    );
  }
}

/**
 * POSTs `payload` as JSON to a webhook endpoint through {@link safeFetch}.
 *
 * Private/loopback destinations are refused unless the caller declared
 * `allowPrivateDestination`, which is what the `network:private` entitlement is
 * granted against — and, when an enforcer is registered, that grant is
 * re-checked here against the URL actually resolved
 * ({@link assertPrivateDestinationGranted}), because the declaration graded at
 * entitlement-evaluation time need not be the one `execute()` receives. A
 * permitted private destination additionally overrides
 * `readSuccessBody` and `includeBodyInError` to `false`: those flags
 * are a ceiling set by the calling task, and no reply from an internal host is
 * ever surfaced — otherwise a notification task doubles as an SSRF read
 * primitive with the answer smuggled out through an error message.
 *
 * Redirects are refused rather than followed. Following one would re-issue this
 * exact request — method, serialized payload and caller headers — at whatever
 * origin the `Location` names, handing the notification payload and any
 * credentials to a host the caller never configured, and repeating the message
 * once per hop. No mainstream webhook receiver answers a POST with a 3xx.
 */
export async function postWebhookJson(request: WebhookPostRequest): Promise<WebhookPostResult> {
  const { url, label } = request;
  const classification = classifyUrl(url);
  if (classification.kind === "invalid") {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.INVALID_URL,
      `Refusing to post ${label} to an invalid URL: ${classification.reason ?? "malformed"}`,
      { url: redactWebhookUrl(url) }
    );
  }

  const isPrivate = classification.kind === "private";
  if (isPrivate && !request.allowPrivateDestination) {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.PRIVATE_DENIED,
      `Refusing to post ${label} to a private/internal destination. ` +
        `Set 'allow_private_destination' and grant the 'network:private' entitlement.`,
      { url: redactWebhookUrl(url) }
    );
  }
  if (isPrivate) {
    await assertPrivateDestinationGranted(request.registry, url, label);
  }
  const timeoutSignal =
    request.timeout !== undefined && request.timeout > 0
      ? AbortSignal.timeout(request.timeout)
      : undefined;
  const signal = timeoutSignal ? AbortSignal.any([request.signal, timeoutSignal]) : request.signal;

  // Built BEFORE the request `try`. A payload carrying a circular reference or
  // a `BigInt` is a caller mistake no retry can fix, but the catch below has to
  // treat anything it does not recognize as a transient network failure — so a
  // throw from here would be retried forever under a misleading message.
  let body: string | undefined;
  let headers: Record<string, string>;
  try {
    body = JSON.stringify(request.payload);
    headers = { "Content-Type": "application/json", ...request.headers };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw createFetchUrlJobError(
      FetchUrlErrorCode.CONFIGURATION,
      `Cannot build the ${label} request for ${redactWebhookUrl(url)}: ` +
        `${redactWebhookUrlIn(detail, url)}`,
      { url: redactWebhookUrl(url) }
    );
  }

  let response: Response;
  try {
    response = await safeFetch(url, {
      method: "POST",
      headers,
      body,
      signal,
      redirect: "error",
      allowPrivate: isPrivate,
      privateResourceScopes: isPrivate ? [urlResourcePattern(url)] : undefined,
    });
  } catch (err) {
    throw toRedactedWebhookError(err, url, label, request.signal);
  }

  if (response.ok) {
    if (!request.readSuccessBody || isPrivate) {
      // Slack answers 200 with a short `ok` body even though we don't want it.
      // An unconsumed body keeps the underlying connection out of the agent's
      // pool until GC, so cancel it explicitly instead of dropping it.
      await response.body?.cancel().catch(() => {});
      return { status: response.status, body: "" };
    }
    // Redacted BEFORE truncating: cutting first can slice a token in half so
    // it no longer matches, leaving a usable prefix in the task output. Echo
    // endpoints (webhook.site, RequestBin) reply with the request line, which
    // carries the whole webhook URL.
    //
    // A residual gap remains and is deliberately not closed here: `readBodyText`
    // stops at `SECURITY_LIMITS.webhookMaxResponseBodyBytes`, so a token
    // straddling that boundary can still leave a partial behind.
    const text = await readBodyText(response);
    return {
      status: response.status,
      body: truncate(redactWebhookUrlIn(text, url), MAX_RESPONSE_BODY_CHARS),
    };
  }

  const failureBody = await readBodyText(response);
  const retryDate = retryDateFromResponse(response, failureBody, request.retryAfterFromJsonBody);
  const redacted = redactWebhookUrl(url);
  // The status is still reported for a private destination — the reply BODY is
  // what would turn a POST at an internal service into a read of it.
  const bodySuffix =
    request.includeBodyInError && !isPrivate && failureBody.length > 0
      ? `: ${truncate(redactWebhookUrlIn(failureBody, url), MAX_ERROR_BODY_CHARS)}`
      : "";

  throw createFetchUrlJobError(
    httpStatusToFetchUrlErrorCode(response.status),
    `Failed to post ${label} to ${redacted}: ${response.status} ${response.statusText}${bodySuffix}`,
    {
      url: redacted,
      httpStatus: response.status,
      httpStatusText: response.statusText,
      retryDate,
    }
  );
}

/**
 * Static entitlements shared by every webhook notification task.
 *
 * `credential` is declared optional HERE because the static shape describes the
 * task class, which may or may not be configured to use the store. An optional
 * entitlement is skipped outright by `evaluatePolicy`, so this declaration is
 * documentation only; {@link webhookPrivateEntitlements} upgrades it to a real
 * requirement on the instance that actually configures a credential key.
 */
export function webhookBaseEntitlements(reason: string): TaskEntitlements {
  return {
    entitlements: [
      { id: Entitlements.NETWORK_HTTP, reason },
      {
        id: Entitlements.CREDENTIAL,
        reason: "May resolve the webhook URL from the credential store",
        optional: true,
      },
    ],
  };
}

/**
 * Adds a `network:private` requirement when — and only when — the task
 * DECLARES that it intends to post to a private/internal destination.
 *
 * The destination is genuinely unknowable here: `ITask.entitlements()` is
 * synchronous and the enforcer checks it before the runner resolves
 * `format: "credential"` inputs, so a credential-backed URL does not exist yet.
 * Deriving the requirement from the URL therefore either fails open (grade the
 * decoy `url` while the request goes wherever the credential points) or forces
 * an unscoped grant on every credential-using instance, public or not.
 *
 * So the decision is an explicit input instead, and {@link postWebhookJson}
 * enforces it at execute time against the URL actually resolved. The
 * declaration is scoped to the `url` port when that port is the destination;
 * with a credential key the URL is unknown here, so the grant is unscoped and
 * says why.
 *
 * Only an explicit `false` opts out: a root task's run-input is applied after
 * entitlements are evaluated, so an unset flag is "not yet knowable" and fails
 * closed.
 */
export function webhookPrivateEntitlements(
  base: TaskEntitlements,
  url: unknown,
  credentialKey: unknown,
  allowPrivate: unknown
): TaskEntitlements {
  const credentialWins = typeof credentialKey === "string" && credentialKey.length > 0;
  // A configured credential key is no longer a "may": this instance WILL read
  // the credential store. `mergeEntitlements` keeps the most restrictive
  // `optional`, so this upgrades the base declaration into an enforced one.
  const withCredential = credentialWins
    ? mergeEntitlements(base, {
        entitlements: [
          {
            id: Entitlements.CREDENTIAL,
            reason: "Resolves the webhook URL — the secret itself — from the credential store",
          },
        ],
      })
    : base;
  if (allowPrivate === false) {
    return withCredential;
  }
  const scoped = !credentialWins && typeof url === "string" && url.length > 0;
  return mergeEntitlements(withCredential, {
    entitlements: [
      {
        id: Entitlements.NETWORK_PRIVATE,
        reason: scoped
          ? "'allow_private_destination' is set, permitting a private/internal destination on the configured `url`"
          : "'allow_private_destination' is set and the webhook URL comes from the credential store, so the destination is not knowable during entitlement evaluation",
        resources: scoped ? [urlResourcePattern(url as string)] : undefined,
      },
    ],
  });
}

/**
 * Builds a JSON payload from the supplied entries, omitting absent keys rather
 * than serializing them as `null`.
 *
 * Empty arrays are dropped alongside `undefined`: an unset array-typed port
 * materializes as `[]`, and both Slack and Discord reject an empty `blocks` /
 * `embeds` list, so an empty list can only mean "not supplied".
 */
export function compactPayload(
  entries: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    payload[key] = value;
  }
  return payload;
}
