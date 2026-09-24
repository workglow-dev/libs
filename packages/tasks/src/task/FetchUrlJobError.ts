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
  REDIRECT_NOT_FOLLOWED: "FETCH_REDIRECT_NOT_FOLLOWED",
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
  body?: string
): FetchUrlJobErrorInstance {
  const code = httpStatusToFetchUrlErrorCode(status);
  const httpErrorMessage = jsonMessageFromHttpBody(body);
  const statusPart = `${status} ${statusText}`;
  const message =
    httpErrorMessage !== undefined
      ? `Failed to fetch ${url}: ${statusPart}: ${httpErrorMessage}`
      : `Failed to fetch ${url}: ${statusPart}`;
  return createFetchUrlJobError(code, message, {
    url,
    httpStatus: status,
    httpStatusText: statusText,
    httpErrorMessage,
    retryDate,
  });
}

/** Reads `{message}` from a JSON error body, if that field is a non-empty string. */
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
