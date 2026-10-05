/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AbortSignalJobError,
  JobError,
  PermanentJobError,
  RetryableJobError,
} from "@workglow/job-queue";

/**
 * Machine-readable error codes for {@link FetchUrlJob} / {@link FetchUrlTask}.
 * Persisted as `error_code` on queued jobs when a fetch fails.
 */
export const FetchUrlErrorCode = {
  INVALID_URL: "FETCH_INVALID_URL",
  PRIVATE_DENIED: "FETCH_PRIVATE_DENIED",
  SCOPE_DENIED: "FETCH_SCOPE_DENIED",
  DNS_FAILED: "FETCH_DNS_FAILED",
  TOO_MANY_REDIRECTS: "FETCH_TOO_MANY_REDIRECTS",
  REDIRECT_MISSING_LOCATION: "FETCH_REDIRECT_MISSING_LOCATION",
  HTTP_CLIENT_ERROR: "FETCH_HTTP_CLIENT_ERROR",
  HTTP_RATE_LIMITED: "FETCH_HTTP_RATE_LIMITED",
  HTTP_SERVER_ERROR: "FETCH_HTTP_SERVER_ERROR",
  RESPONSE_PARSE_ERROR: "FETCH_RESPONSE_PARSE_ERROR",
  INVALID_RESPONSE_TYPE: "FETCH_INVALID_RESPONSE_TYPE",
  NETWORK_ERROR: "FETCH_NETWORK_ERROR",
  NO_RESPONSE_BODY: "FETCH_NO_RESPONSE_BODY",
  CONFIGURATION: "FETCH_CONFIGURATION",
  CONTENT_LENGTH_MISMATCH: "FETCH_CONTENT_LENGTH_MISMATCH",
  /**
   * The request failed after body bytes had already been delivered to the
   * consumer. Deliberately absent from {@link FETCH_URL_RETRYABLE_ERROR_CODES}:
   * a retry re-issues from byte 0 while the consumer's stream subscription
   * survives the attempt, so the partial body and the retry's full body would
   * concatenate into a corrupt result the job then reports as success. Distinct
   * from {@link FetchUrlErrorCode.NETWORK_ERROR}, which is the same wire failure
   * before the first byte reached anyone and stays retryable.
   */
  BODY_TRUNCATED: "FETCH_BODY_TRUNCATED",
  /**
   * A 307/308 redirect crossed to a different origin while the request carried
   * a body. 307/308 preserve method and body by definition, so there is no
   * downgrade that both withholds the body and still performs the write the
   * caller asked for. Deliberately absent from
   * {@link FETCH_URL_RETRYABLE_ERROR_CODES}: a retry re-issues the same hop and
   * meets the same refusal.
   */
  REDIRECT_BODY_NOT_REPLAYED: "FETCH_REDIRECT_BODY_NOT_REPLAYED",
} as const;

export type FetchUrlErrorCodeValue = (typeof FetchUrlErrorCode)[keyof typeof FetchUrlErrorCode];

/** Error codes that should be retried by the job queue. */
export const FETCH_URL_RETRYABLE_ERROR_CODES: ReadonlySet<FetchUrlErrorCodeValue> = new Set([
  FetchUrlErrorCode.HTTP_RATE_LIMITED,
  FetchUrlErrorCode.HTTP_SERVER_ERROR,
  FetchUrlErrorCode.NETWORK_ERROR,
]);

export function isFetchUrlErrorCode(
  value: string | undefined | null
): value is FetchUrlErrorCodeValue {
  if (!value) return false;
  return (Object.values(FetchUrlErrorCode) as string[]).includes(value);
}

export function isFetchUrlRetryableErrorCode(
  code: string | undefined | null
): code is FetchUrlErrorCodeValue {
  return isFetchUrlErrorCode(code) && FETCH_URL_RETRYABLE_ERROR_CODES.has(code);
}

export interface FetchUrlJobErrorDetails {
  readonly url?: string;
  readonly httpStatus?: number;
  readonly httpStatusText?: string;
  readonly httpErrorMessage?: string;
}

export type FetchUrlJobErrorInstance = JobError & {
  code: FetchUrlErrorCodeValue;
  url?: string;
  httpStatus?: number;
  httpStatusText?: string;
  httpErrorMessage?: string;
  retryDate?: Date;
};

function attachFetchUrlFields(
  error: JobError,
  code: FetchUrlErrorCodeValue,
  details: FetchUrlJobErrorDetails | undefined
): FetchUrlJobErrorInstance {
  const withCode = error as FetchUrlJobErrorInstance;
  withCode.code = code;
  if (details?.url !== undefined) {
    withCode.url = details.url;
  }
  if (details?.httpStatus !== undefined) {
    withCode.httpStatus = details.httpStatus;
  }
  if (details?.httpStatusText !== undefined) {
    withCode.httpStatusText = details.httpStatusText;
  }
  if (details?.httpErrorMessage !== undefined) {
    withCode.httpErrorMessage = details.httpErrorMessage;
  }
  return withCode;
}

/**
 * Create a {@link JobError} for a fetch failure with a stable `code` for persistence.
 */
export function createFetchUrlJobError(
  code: FetchUrlErrorCodeValue,
  message: string,
  options?: FetchUrlJobErrorDetails & { retryDate?: Date }
): FetchUrlJobErrorInstance {
  const base = FETCH_URL_RETRYABLE_ERROR_CODES.has(code)
    ? new RetryableJobError(message, options?.retryDate)
    : new PermanentJobError(message);
  return attachFetchUrlFields(base, code, options);
}

/**
 * Reconstruct a fetch error from persisted queue fields (`error`, `error_code`).
 */
export function fetchUrlJobErrorFromPersisted(
  message: string,
  errorCode: string | undefined
): JobError | undefined {
  if (!isFetchUrlErrorCode(errorCode)) {
    return undefined;
  }
  if (FETCH_URL_RETRYABLE_ERROR_CODES.has(errorCode)) {
    return attachFetchUrlFields(new RetryableJobError(message), errorCode, undefined);
  }
  return attachFetchUrlFields(new PermanentJobError(message), errorCode, undefined);
}

/**
 * Adapter for {@link registerErrorCodeReconstructor}. Reconstructs a
 * `FetchUrlJobError`-shaped error from a persisted `FETCH_*` code.
 *
 * Unknown future codes that still start with `FETCH_` fall back to a generic
 * `PermanentJobError` so a forward-compat worker can persist a new code and
 * an older client can still surface a typed error (with a warning logged so
 * the version skew is visible).
 */
export function buildFetchUrlError(errorCode: string, message: string): JobError {
  const reconstructed = fetchUrlJobErrorFromPersisted(message, errorCode);
  if (reconstructed) {
    return reconstructed;
  }

  console.warn(
    `buildFetchUrlError: unknown FETCH_* error code "${errorCode}" — falling back to PermanentJobError`
  );
  const fallback = new PermanentJobError(message);
  fallback.code = errorCode;
  return fallback;
}

export function httpStatusToFetchUrlErrorCode(status: number): FetchUrlErrorCodeValue {
  if (status === 429) {
    return FetchUrlErrorCode.HTTP_RATE_LIMITED;
  }
  if (status === 503) {
    return FetchUrlErrorCode.HTTP_SERVER_ERROR;
  }
  if (status >= 500) {
    return FetchUrlErrorCode.HTTP_SERVER_ERROR;
  }
  return FetchUrlErrorCode.HTTP_CLIENT_ERROR;
}

export function createFetchUrlHttpError(
  url: string,
  status: number,
  statusText: string,
  retryDate?: Date,
  body?: string,
  options?: HttpErrorDetailOptions
): FetchUrlJobErrorInstance {
  const code = httpStatusToFetchUrlErrorCode(status);
  const statusPart = `${status} ${statusText}`;
  const detail = httpErrorDetailFromBody(body, options);
  // A body that only restates the status line (`404 Not Found` answering with
  // `Not Found`) adds nothing to the message.
  const redundant =
    detail !== undefined &&
    [statusText.trim(), statusPart.trim(), String(status)].some(
      (s) => s !== "" && s.toLowerCase() === detail.toLowerCase()
    );
  const httpErrorMessage = redundant ? undefined : detail?.replace(/"/g, "'");
  // The remote's words ride inside a fixed, quoted frame so a reader (a model
  // included) can tell them from this task's own text; `sanitizeHttpErrorDetail`
  // guarantees the detail cannot contain the frame's delimiters or a newline.
  const message =
    httpErrorMessage !== undefined
      ? `Failed to fetch ${url}: ${statusPart} [remote said: "${httpErrorMessage}"]`
      : `Failed to fetch ${url}: ${statusPart}`;
  return createFetchUrlJobError(code, message, {
    url,
    httpStatus: status,
    httpStatusText: statusText,
    httpErrorMessage,
    retryDate,
  });
}

export interface HttpErrorDetailOptions {
  /**
   * Exact secret values (resolved credentials, key-like request headers) to
   * blank out of the quoted detail wherever a server echoed them back.
   */
  readonly secrets?: readonly string[];
  /**
   * The response `Content-Type`. When given, a body that is not text, JSON or
   * XML is never quoted raw. Omitted means unknown and does not restrict.
   */
  readonly contentType?: string;
}

/** A private-use placeholder, so the brackets in the final text survive the bracket neutralising. */
const REDACTED = "\uE000";
const REDACTED_TEXT = "[redacted]";

/** Shortest secret worth scanning for; shorter ones would shred ordinary words. */
const MIN_SECRET_CHARS = 4;

const SECRET_PARAM_NAMES =
  "api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth(?:orization)?|token|secret|client[_-]?secret|password|passwd|pwd|signature|sig|key";

const SECRET_PATTERNS: readonly RegExp[] = [
  // `Authorization: Bearer abc1`, `Basic dXNlcjpwdw==`; the lookahead leaves prose (`Basic authentication required`) alone
  /\b(?:bearer|basic)\s+(?=[A-Za-z0-9._~+/=-]*[\d=])[A-Za-z0-9._~+/=-]{6,}/gi,
  // `api_key=abc`, `"token": "abc"`, `password: abc`
  new RegExp(`\\b(${SECRET_PARAM_NAMES})\\b(["']?\\s*[:=]\\s*["']?)[^\\s"'&,;}<>]{3,}`, "gi"),
  // Provider-shaped keys quoted without any label (`Invalid API key: sk-ant-…`).
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat|xox[abprs]|AKIA|AIza)[A-Za-z0-9_-]{12,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Makes remote text safe to store and to hand to a model: secrets blanked out,
 * control and invisible/bidi characters dropped, markup, backticks and the
 * message frame's own delimiters neutralised, whitespace collapsed to one line.
 * Runs before bounding so a secret cut by the length cap is not left half-visible.
 */
export function sanitizeHttpErrorDetail(text: string, secrets: readonly string[] = []): string {
  let out = text;
  // Longest first so a secret containing another is replaced whole.
  const known = [...new Set(secrets.filter((s) => s.length >= MIN_SECRET_CHARS))].sort(
    (a, b) => b.length - a.length
  );
  for (const secret of known) {
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  out = out.replace(SECRET_PATTERNS[0]!, REDACTED);
  out = out.replace(
    SECRET_PATTERNS[1]!,
    (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`
  );
  for (const pattern of SECRET_PATTERNS.slice(2)) out = out.replace(pattern, REDACTED);
  out = out
    .replace(
      // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
      /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2028\u2029\u2066-\u2069\uFEFF]/g,
      " "
    )
    .replace(/[<>`]/g, "")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")");
  return out.replaceAll(REDACTED, REDACTED_TEXT);
}

function contentTypeAllowsRawQuote(contentType: string | undefined): boolean {
  if (contentType === undefined) return true;
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return type.startsWith("text/") || /(?:^|[/+])(?:json|xml)$/.test(type);
}

/** Longest detail {@link httpErrorDetailFromBody} will put into an error message. */
export const HTTP_ERROR_DETAIL_MAX_CHARS = 300;

/**
 * String fields an error body may carry its explanation in, most specific
 * first. `message` beats `error` because APIs that send both use `error` for
 * the status phrase (`{"error":"Bad Request","message":"…"}`), and
 * `error_description` beats `error` for the same reason in OAuth bodies.
 */
const HTTP_ERROR_TEXT_KEYS: readonly string[] = [
  "message",
  "description",
  "error_description",
  "detail",
  "error",
];

/** How deep {@link jsonErrorText} descends through wrapping objects. */
const HTTP_ERROR_JSON_MAX_DEPTH = 3;

/**
 * A concise, human-readable explanation from a non-2xx body, or `undefined`
 * when there is nothing worth quoting.
 *
 * JSON bodies yield their error text — a string `message` / `description` /
 * `error_description` / `detail` / `error`, found at the top level or under a
 * wrapping object (`{"error":{"description":…}}`,
 * `{"chart":{"result":null,"error":{"description":…}}}`). Other text yields a
 * whitespace-collapsed snippet (an HTML page, its `<title>`). Binary, or
 * markup with nothing to quote, yields `undefined`. The result is capped at
 * {@link HTTP_ERROR_DETAIL_MAX_CHARS}, because it lands in a log line and in
 * a persisted `error` column.
 */
export function httpErrorDetailFromBody(
  body: string | undefined,
  options?: HttpErrorDetailOptions
): string | undefined {
  const raw = rawHttpErrorDetail(body, options?.contentType);
  return raw === undefined ? undefined : boundHttpErrorDetail(raw, options?.secrets);
}

function rawHttpErrorDetail(
  body: string | undefined,
  contentType: string | undefined
): string | undefined {
  if (body === undefined) return undefined;
  const trimmed = body.trim();
  if (trimmed === "") return undefined;
  let parsed: unknown;
  let isJson = false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      parsed = JSON.parse(trimmed);
      isJson = true;
    } catch {
      // A JSON body cut off at the read cap, or not JSON at all: quote it as text.
    }
  }
  if (isJson) {
    return jsonErrorText(parsed, 0);
  }
  if (looksBinary(trimmed)) return undefined;
  if (/^<(?:!doctype|html|\?xml|head|body)/i.test(trimmed)) {
    // An HTML error page's `<title>`, or an XML error document's `<Message>`
    // (S3 and its imitators); the rest of the markup is noise.
    const text =
      /<title[^>]*>([^<]*)<\/title>/i.exec(trimmed)?.[1] ??
      /<message[^>]*>([^<]*)<\/message>/i.exec(trimmed)?.[1];
    return text;
  }
  if (!contentTypeAllowsRawQuote(contentType)) return undefined;
  return trimmed;
}

/**
 * Reads `{message}` from a JSON error body, if that field is a non-empty string.
 * @deprecated Use {@link httpErrorDetailFromBody}, which also reads the other
 * common error shapes and plain-text bodies.
 */
export function jsonMessageFromHttpBody(body: string | undefined): string | undefined {
  if (body === undefined || body.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const message = (parsed as { message?: unknown }).message;
    if (typeof message !== "string") return undefined;
    const trimmed = message.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function jsonErrorText(value: unknown, depth: number): string | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    return text === "" ? undefined : text;
  }
  if (value === null || typeof value !== "object" || depth > HTTP_ERROR_JSON_MAX_DEPTH) {
    return undefined;
  }
  if (Array.isArray(value)) {
    // `{"errors":[{"message":…}]}` — the first entry speaks for the rest.
    return value.length > 0 ? jsonErrorText(value[0], depth + 1) : undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of HTTP_ERROR_TEXT_KEYS) {
    const field = record[key];
    if (typeof field === "string" && field.trim() !== "") return field.trim();
  }
  // An `error` / `errors` object is the explanation's container by name;
  // try it before any other wrapper so `{"data":…,"error":{…}}` reads the error.
  for (const key of ["error", "errors"]) {
    if (record[key] !== null && typeof record[key] === "object") {
      const nested = jsonErrorText(record[key], depth + 1);
      if (nested !== undefined) return nested;
    }
  }
  for (const [key, field] of Object.entries(record)) {
    if (key === "error" || key === "errors") continue;
    if (field === null || typeof field !== "object" || Array.isArray(field)) continue;
    const nested = jsonErrorText(field, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * Control characters other than whitespace, or U+FFFD from bytes that were not
 * UTF-8, mark a body that is not text worth quoting.
 */
function looksBinary(text: string): boolean {
  // oxlint-disable-next-line no-control-regex -- detecting control bytes is the point
  return /[\u0000-\u0008\u000E-\u001F\u007F\uFFFD]/.test(text);
}

function boundHttpErrorDetail(text: string, secrets?: readonly string[]): string | undefined {
  const collapsed = sanitizeHttpErrorDetail(text, secrets).replace(/\s+/g, " ").trim();
  if (collapsed === "") return undefined;
  if (collapsed.length <= HTTP_ERROR_DETAIL_MAX_CHARS) return collapsed;
  let cut = collapsed.slice(0, HTTP_ERROR_DETAIL_MAX_CHARS - 1);
  // Never end on half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/**
 * True when `error` (or a nested `cause`) is a dropped connection / DNS /
 * timeout rather than a completed body we failed to decode. `response.text()`
 * and `response.json()` throw these when the peer closes mid-body; they must
 * not be classified as {@link FetchUrlErrorCode.RESPONSE_PARSE_ERROR}.
 *
 * Abort is excluded: a cancelled fetch is not a transient network blip.
 *
 * A `SyntaxError` is excluded from the MESSAGE heuristic — never from the
 * `code` / `cause` checks — because a decode failure's message embeds
 * server-controlled bytes: V8 quotes a snippet of the body into it
 * (`Unexpected token 'G', "Gateway timeout..." is not valid JSON`), so a
 * response could otherwise choose its own error code and keep the queue
 * retrying a URL that can never decode. A body that reached `JSON.parse` at all
 * arrived complete — the stream errors before the parser runs when the peer
 * drops mid-body — so a `SyntaxError`'s message is never network evidence.
 * Discriminated by `name` rather than `instanceof` because this classifier is
 * reachable from worker-hosted job code, where realms differ.
 */
export function isFetchUrlNetworkCause(error: unknown, depth = 0): boolean {
  if (error === null || typeof error !== "object" || depth > 4) return false;
  const e = error as { code?: unknown; cause?: unknown; name?: string; message?: unknown };
  if (e.name === "AbortError" || e.name === "AbortSignalJobError") return false;
  const code = e.code;
  if (typeof code === "string") {
    if (NETWORK_ERRNO_PATTERN.test(code) || NETWORK_UNDICI_CODES.has(code)) return true;
  }
  const message = typeof e.message === "string" ? e.message : "";
  if (e.name !== "SyntaxError" && NETWORK_MESSAGE_PATTERN.test(message)) return true;
  return e.cause !== undefined ? isFetchUrlNetworkCause(e.cause, depth + 1) : false;
}

const NETWORK_ERRNO_PATTERN =
  /^E(?:CONNRESET|TIMEDOUT|PIPE|AI_AGAIN|NOTFOUND|HOSTUNREACH|NETUNREACH|CONNREFUSED)$/;

const NETWORK_UNDICI_CODES: ReadonlySet<string> = new Set([
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const NETWORK_MESSAGE_PATTERN =
  /network|timeout|timed out|fetch failed|socket hang up|socket connection was closed|other side closed|econnreset|etimedout|enotfound|eai_again|und_err_socket|getaddrinfo/i;

export function wrapFetchUrlNetworkError(url: string, cause: unknown): FetchUrlJobErrorInstance {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return createFetchUrlJobError(
    FetchUrlErrorCode.NETWORK_ERROR,
    `Network error fetching ${url}: ${detail}`,
    { url }
  );
}

export function isFetchUrlJobError(error: unknown): error is FetchUrlJobErrorInstance {
  return error instanceof JobError && isFetchUrlErrorCode((error as JobError).code);
}

/** @internal Used by fetch helpers when the run was aborted. */
export function createFetchUrlAbortedError(): AbortSignalJobError {
  return new AbortSignalJobError("Fetch aborted");
}
