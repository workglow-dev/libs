/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IJobExecuteContext, JobHandle, StreamEventLike } from "@workglow/job-queue";
import { AbortSignalJobError, Job, RetryableJobError } from "@workglow/job-queue";
import type {
  IExecuteContext,
  IRunConfig,
  RegisteredQueue,
  StreamEvent,
  TaskConfig,
  TaskEntitlements,
} from "@workglow/task-graph";
import {
  CreateWorkflow,
  Entitlements,
  getJobQueueFactory,
  getTaskQueueRegistry,
  JobTaskFailedError,
  mergeEntitlements,
  Task,
  TaskConfigSchema,
  TaskConfigurationError,
  TaskEntitlementError,
  TaskFailedError,
  TaskInvalidInputError,
  Workflow,
} from "@workglow/task-graph";
import { asText, getLogger } from "@workglow/util";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";
import { retryDateFromRetryAfterHeader } from "../util/RetryAfter";
import { safeFetch } from "../util/SafeFetch";
import { classifyUrl, urlMatchesScope, urlResourcePattern } from "../util/UrlClassifier";
import {
  applyCredentialToHeaders,
  credentialHeaderName,
  CredentialSchemes,
  DEFAULT_CREDENTIAL_SCHEME,
} from "./FetchUrlCredentials";
import {
  createFetchUrlAbortedError,
  createFetchUrlHttpError,
  createFetchUrlJobError,
  FetchUrlErrorCode,
  isFetchUrlJobError,
  isFetchUrlNetworkCause,
  wrapFetchUrlNetworkError,
} from "./FetchUrlJobError";

const inputSchema = {
  type: "object",
  properties: {
    url: {
      type: "string",
      title: "URL",
      description: "The URL to fetch from",
      format: "uri",
    },
    method: {
      enum: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"],
      title: "Method",
      description: "The HTTP method to use",
      default: "GET",
    },
    headers: {
      type: "object",
      additionalProperties: {
        type: "string",
      },
      title: "Headers",
      description: "The headers to send with the request",
    },
    body: {
      type: "string",
      title: "Body",
      description: "The body of the request",
    },
    response_type: {
      enum: ["stream", "text", "json", "blob", "arraybuffer"],
      title: "Response Type",
      description:
        "What to materialize from the response. 'stream' materializes nothing — the bytes " +
        "reach the 'body' port and the cache; read metadata.contentType to decide. The other " +
        "values additionally populate the matching derived port. Required, with no default: " +
        "whether a caller wants bytes buffered into memory is theirs to state, and a default " +
        "would silently pick one for a caller who never considered the question.",
    },
    timeout: {
      type: "number",
      title: "Timeout",
      description: "Request timeout in milliseconds",
    },
    credential_key: {
      type: "string",
      format: "credential",
      title: "Credential Key",
      description:
        "Key to look up in the credential store. The resolved secret is placed on the request according to credential_scheme. Incompatible with the queued path, which would persist the secret.",
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
  required: ["url", "response_type"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    body: {
      title: "Body",
      description:
        "The raw response body as an ordered byte stream. Always present; the cache sink " +
        "and any streaming consumer read this port.",
      "x-stream": "binary",
      format: "binary",
    },
    json: { title: "JSON", description: "The JSON response" },
    text: { type: "string", title: "Text", description: "The text response" },
    blob: { title: "Blob", description: "The blob response" },
    arraybuffer: { title: "ArrayBuffer", description: "The arraybuffer response" },
    metadata: {
      type: "object",
      properties: {
        contentType: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        status: { type: "number" },
        notModified: { type: "boolean" },
      },
      required: ["contentType", "headers", "status", "notModified"],
      additionalProperties: false,
      title: "Response Metadata",
      description: "HTTP response metadata: content type, headers, status, and 304 state",
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type FetchUrlResponseType = "stream" | "text" | "json" | "blob" | "arraybuffer";
export type FetchUrlTaskInput = FromSchema<typeof inputSchema>;
export type FetchUrlTaskOutput = FromSchema<typeof outputSchema>;

/**
 * Strict `Content-Length` parse, fail-closed. `parseInt` accepts trailing
 * garbage ("123abc" -> 123), which would let a malformed header defeat the
 * truncation check this feeds. RFC 9112 §6.3 permits repeated headers to be
 * combined as "v1, v2": equal duplicates are valid, mismatched values are a
 * protocol error. Returns `undefined` when the header states no size, which
 * skips the size assertion: either absent (chunked transfer), or present and
 * empty — `Headers.get` answers `""` rather than `null` for a proxy that emits
 * a bare `Content-Length:`, and reading "the origin stated nothing" as a
 * malformed value would fail such a fetch permanently.
 */
export function parseContentLength(header: string | null, url: string): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const parts = header.split(",").map((p) => p.trim());
  if (parts.some((p) => !/^\d+$/.test(p))) {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.CONTENT_LENGTH_MISMATCH,
      `Invalid Content-Length header ${JSON.stringify(header)} for ${url}`,
      { url }
    );
  }
  if (new Set(parts).size > 1) {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.CONTENT_LENGTH_MISMATCH,
      `Conflicting Content-Length values ${JSON.stringify(header)} for ${url}`,
      { url }
    );
  }
  const parsed = Number(parts[0]);
  if (parsed > Number.MAX_SAFE_INTEGER) {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.CONTENT_LENGTH_MISMATCH,
      `Content-Length ${parts[0]} exceeds MAX_SAFE_INTEGER for ${url}`,
      { url }
    );
  }
  return parsed;
}

/**
 * True when the body arrived under a content coding, so what the runtime hands
 * back is not what the origin measured.
 *
 * Nothing here sets `Accept-Encoding`, and both undici and browsers send
 * `gzip, deflate, br` on their own and then transparently decode. The origin's
 * `Content-Length` describes the ENCODED octets while `response.body` yields
 * the decoded ones, so comparing the two fails every compressed response that
 * states a length — and drives progress far past 100% on the way. Fetch leaves
 * `Content-Encoding` on the response after decoding, which is the only signal
 * that the stated size measures something else.
 *
 * `identity` names no coding, so it does not disqualify the length.
 */
export function isContentEncoded(header: string | null): boolean {
  if (header === null) return false;
  return header
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .some((coding) => coding.length > 0 && coding !== "identity");
}

/**
 * Issues the request and yields the body in arrival order, reporting progress
 * against `Content-Length` when the origin states one that measures the bytes
 * we actually receive, and asserting the advertised size at end of stream.
 *
 * There is no wrapper stream: the previous implementation rebuilt a second
 * ReadableStream (and a second Response around it) solely so a byte counter
 * could sit between the socket and `.text()`. The caller owns the loop now, so
 * the count happens here.
 */
async function* streamResponseBody(
  response: Response,
  url: string,
  signal: AbortSignal,
  onProgress: (progress: number) => Promise<void>
): AsyncGenerator<Uint8Array> {
  if (!response.body) {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.NO_RESPONSE_BODY,
      "ReadableStream not supported in this environment.",
      { url }
    );
  }
  let receivedBytes = 0;
  const reader = response.body.getReader();
  let totalBytes: number | undefined;
  try {
    // Parsed inside the try (reader already acquired) so an invalid/conflicting
    // header cancels the body via the finally below instead of leaking an
    // undrained response. A content-encoded body is left unmeasured entirely:
    // its stated length counts the encoded octets, so neither the assertion nor
    // the progress denominator has anything to say about the decoded bytes this
    // loop counts.
    totalBytes = isContentEncoded(response.headers.get("content-encoding"))
      ? undefined
      : parseContentLength(response.headers.get("content-length"), url);
    while (true) {
      if (signal.aborted) throw createFetchUrlAbortedError();
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      yield value;
      if (totalBytes) await onProgress((receivedBytes / totalBytes) * 100);
    }
  } finally {
    // Cancelling an already-errored source rejects; the consumer has the
    // failure either way, so an unhandled rejection here would only crash
    // the process.
    void reader.cancel().catch(() => {});
  }
  if (totalBytes !== undefined && receivedBytes !== totalBytes) {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.CONTENT_LENGTH_MISMATCH,
      `Content-Length mismatch for ${url}: advertised ${totalBytes} bytes, received ${receivedBytes}`,
      { url }
    );
  }
}

/**
 * Classifies a failure raised while the response body was in flight.
 *
 * Retry is safe only while nothing has been delivered. The consumer's stream
 * subscription outlives an attempt, so a second attempt's deltas land on the
 * same listener as the first attempt's: the two bodies concatenate, the job
 * then completes, and the run reports success over corrupt bytes. A
 * `Content-Length` check cannot catch that — it is evaluated per attempt, and
 * the retry attempt passes it.
 *
 * So once a delta has been emitted, no failure may stay retryable: a
 * retryable classification is replaced by
 * {@link FetchUrlErrorCode.BODY_TRUNCATED}, which the worker fails rather than
 * reschedules. An already-terminal error keeps its own code — it is not going
 * to be retried, and its diagnosis is worth more than a uniform label. Before
 * the first delta everything is unchanged, which is what keeps 429 /
 * 5xx / DNS / connect-timeout retries — the case a rate-limited caller depends
 * on — working exactly as before.
 *
 * `emittedDelta` means *a receiver could exist*, not that bytes reached one.
 * Its source is whether the job context carries `emitStreamEvent` at all, and
 * `JobQueueWorker` supplies that unconditionally — so a queued run with zero
 * subscribers still forfeits its mid-body retry budget. That is the deliberate
 * direction: the alternative is counting live subscribers, and a subscription
 * that arrives between the check and the emit turns a correct retry into a
 * concatenated body. The inline path, where the context genuinely carries no
 * `emitStreamEvent`, is the one that keeps retrying mid-body — which is what
 * stops a large download from spending its whole retry policy on the first
 * reset.
 */
function classifyBodyFailure(err: unknown, url: string, emittedDelta: boolean): unknown {
  if (err instanceof AbortSignalJobError) return err;
  let classified = err;
  if (!isFetchUrlJobError(classified) && isFetchUrlNetworkCause(classified)) {
    // A 200 whose body is still on the wire throws here when the peer resets
    // the socket. That is a network failure, not a decode failure.
    classified = wrapFetchUrlNetworkError(url, classified);
  }
  if (!emittedDelta || !(classified instanceof RetryableJobError)) return classified;
  const detail = classified instanceof Error ? classified.message : String(classified);
  return createFetchUrlJobError(
    FetchUrlErrorCode.BODY_TRUNCATED,
    `Body truncated for ${url} after bytes were already delivered: ${detail}`,
    { url }
  );
}

interface FetchUrlMetadata {
  readonly contentType: string;
  readonly headers: Record<string, string>;
  readonly status: number;
  readonly notModified: boolean;
}

function buildMetadata(response: Response): FetchUrlMetadata {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    contentType: response.headers.get("content-type") ?? "",
    headers,
    status: response.status,
    notModified: response.status === 304,
  };
}

/**
 * True when the request carries a validator, which is what makes a `304` a
 * meaningful answer. An unsolicited `304` is a server protocol error —
 * "unmodified relative to what?" has no answer a caller can act on — so it
 * stays an error rather than being reported as `notModified`.
 */
export function hasConditionalHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((k) => {
    const lower = k.toLowerCase();
    return lower === "if-none-match" || lower === "if-modified-since";
  });
}

/**
 * Releases a response nothing is going to read.
 *
 * An undrained body keeps the connection checked out of the agent's pool until
 * GC gets to it, so a path that throws on the status alone leaks one socket per
 * attempt — and 429/5xx are retryable, so the queued path spends its whole
 * `maxAttempts` budget opening connections it never closes. Cancelling an
 * already-errored or absent body rejects or is a no-op; either way the caller
 * has its own failure to report.
 */
async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

/**
 * The `response_type` values that name a derived port. `"stream"` is
 * deliberately absent: it materializes nothing, so it is handled before this
 * set is ever consulted.
 */
const DERIVED_RESPONSE_TYPES: ReadonlySet<string> = new Set([
  "text",
  "json",
  "blob",
  "arraybuffer",
]);

/**
 * Fails closed on a `response_type` the schema would have rejected.
 *
 * The task layer validates its input, but `JobQueueWorker` calls
 * `job.execute()` on a *persisted* payload with no validation at all — so a job
 * enqueued before `response_type` became required, drained by a worker running
 * the code that requires it, arrives here carrying `undefined`. Treating that
 * as `"stream"` would let it complete successfully with neither `text` nor
 * `json` in its output: a caller that asked for a value gets a silent success
 * with no value, which is worse than any failure.
 */
function assertResponseType(
  value: FetchUrlResponseType | undefined,
  url: string
): asserts value is FetchUrlResponseType {
  if (value === "stream" || (typeof value === "string" && DERIVED_RESPONSE_TYPES.has(value))) {
    return;
  }
  throw createFetchUrlJobError(
    FetchUrlErrorCode.INVALID_RESPONSE_TYPE,
    value === undefined
      ? `Fetch of ${url} carries no response_type. It is required and has no default; a job ` +
          `enqueued before it became required cannot be run — re-enqueue it with an explicit ` +
          `response_type ('stream' reproduces the previous byte-level behaviour).`
      : `Invalid response type: ${String(value)} for ${url}`,
    { url }
  );
}

/**
 * Rejects a `response_type` the request METHOD cannot produce a value for.
 *
 * A HEAD response carries no representation body, so the fetch answers with
 * metadata alone. Pairing it with a derived `response_type` therefore
 * completes successfully with `text`/`json`/`blob` undefined — the same silent
 * success with no value that {@link assertResponseType} exists to prevent,
 * arrived at from the other direction. `"stream"` is the only type HEAD can
 * honestly satisfy: it materializes nothing.
 *
 * `INVALID_RESPONSE_TYPE` is outside `FETCH_URL_RETRYABLE_ERROR_CODES`, so
 * this is a permanent failure that burns no retry budget.
 */
function assertMethodAllowsResponseType(
  method: string | undefined,
  responseType: FetchUrlResponseType,
  url: string
): void {
  if ((method ?? "GET").toUpperCase() !== "HEAD" || responseType === "stream") {
    return;
  }
  throw createFetchUrlJobError(
    FetchUrlErrorCode.INVALID_RESPONSE_TYPE,
    `Fetch of ${url} pairs method HEAD with response_type '${responseType}'. A HEAD response ` +
      `has no body, so no value can be derived from it — use response_type 'stream' and read ` +
      `the metadata, or use GET.`,
    { url }
  );
}

async function buildHttpError(url: string, response: Response): Promise<Error> {
  // The header is remote-controlled, so the bounded parser owns the arithmetic:
  // an unbounded value either parks the job for millennia or overflows into an
  // Invalid Date the queue cannot reschedule from.
  const retryDate = retryDateFromRetryAfterHeader(response.headers.get("Retry-After"));
  const body = await readHttpErrorBody(response);
  return createFetchUrlHttpError(url, response.status, response.statusText, retryDate, body);
}

const HTTP_ERROR_BODY_MAX_BYTES = 4096;

/**
 * Budget for peeking at a non-2xx body. `response.text()` waits for the stream
 * to close, which is how an abandoned error body used to leak a connection: a
 * never-ending readable never settles, so the undici Agent stays checked out.
 * Cancelling the reader when this budget expires (and after a successful peek)
 * is what settles it. In-memory JSON error bodies complete well under this;
 * a hung 5xx stream fails the fetch on status instead of waiting forever.
 */
const HTTP_ERROR_BODY_READ_MS = 100;

async function readHttpErrorBody(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const timer = setTimeout(() => {
    void reader.cancel().catch(() => {});
  }, HTTP_ERROR_BODY_READ_MS);
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < HTTP_ERROR_BODY_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      if (value.byteLength === 0) continue;
      const take = Math.min(value.byteLength, HTTP_ERROR_BODY_MAX_BYTES - received);
      chunks.push(take === value.byteLength ? value : value.subarray(0, take));
      received += take;
    }
  } catch {
    // Timeout cancel rejects an in-flight read. The HTTP status is still the error.
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  if (received === 0) return undefined;
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  return text.length === 0 ? undefined : text;
}

/**
 * Builds the derived port `response_type` named from the collected bytes.
 * `Response.text()` is an unconditional UTF-8 decode per the Fetch standard —
 * it ignores the Content-Type charset — so decoding here is byte-identical to
 * what the previous `.text()` / `.json()` calls produced.
 *
 * `responseType` is typed as possibly `undefined` (rather than trusting the
 * schema's `required` + enum) because `JobQueueWorker` calls `job.execute()`
 * on a *persisted* input with no schema validation — a queued job can carry
 * any string here. Fails closed via {@link assertResponseType}, so an
 * unrecognized value throws `INVALID_RESPONSE_TYPE` instead of falling through
 * to `JSON.parse`, and merges no bytes for a type it is about to reject.
 * `executeStream` asserts the same thing before issuing the request; this stays
 * independently fail-closed because it is reachable from any future caller.
 */
function materializeDerivedPort(
  responseType: FetchUrlResponseType | undefined,
  chunks: readonly Uint8Array[],
  metadata: FetchUrlMetadata,
  url: string
): Record<string, unknown> {
  if (responseType === "stream") return {};
  assertResponseType(responseType, url);
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  if (responseType === "blob") return { blob: new Blob([merged], { type: metadata.contentType }) };
  if (responseType === "arraybuffer") return { arraybuffer: merged.buffer };
  if (responseType === "text" || responseType === "json") {
    const text = new TextDecoder("utf-8").decode(merged);
    return responseType === "text" ? { text } : { json: JSON.parse(text) };
  }
  throw createFetchUrlJobError(
    FetchUrlErrorCode.INVALID_RESPONSE_TYPE,
    `Invalid response type: ${String(responseType)}`,
    { url }
  );
}

export class FetchUrlJob<
  Input extends FetchUrlTaskInput = FetchUrlTaskInput,
  Output = FetchUrlTaskOutput,
> extends Job<Input, Output> {
  static readonly type: string = "FetchUrlJob";

  /**
   * Header names holding a resolved credential, so safeFetch can drop them on a
   * cross-origin redirect. `Authorization` is covered by safeFetch's own
   * strip-set; this exists for `credential_scheme: "header"`, whose header name
   * is caller-chosen and is stripped from the job input before the request is
   * issued — nothing downstream could otherwise know which header is secret.
   *
   * Set by {@link FetchUrlTask} on the inline path only. It is deliberately not
   * a data port: job inputs are persisted durably by the queued path, and this
   * names a credential header. The queued path refuses credentials outright, so
   * there is nothing for it to carry.
   */
  public sensitiveHeaders: readonly string[] | undefined = undefined;

  protected async issueRequest(input: Input, context: IJobExecuteContext): Promise<Response> {
    const classification = classifyUrl(input.url!);
    if (classification.kind === "invalid") {
      throw createFetchUrlJobError(
        FetchUrlErrorCode.INVALID_URL,
        `Refusing to fetch invalid URL ${input.url}: ${classification.reason ?? "malformed"}`,
        { url: input.url }
      );
    }

    // allowPrivate is set to true only when the URL is classified as private:
    // the graph runner (when enforceEntitlements: true) already verified the
    // task was granted `network:private` before reaching this point. When
    // enforceEntitlements is false (default), private URLs are only allowed
    // because the task explicitly declares the network:private entitlement and
    // the caller has opted out of enforcement. safeFetch still re-checks DNS
    // on the server path to defeat DNS rebinding regardless.
    //
    // That "already verified" holds because the URL reaching this job is the
    // one the task checked against its own declaration — entitlements are
    // evaluated on the UNRESOLVED input, so `FetchUrlTask` refuses a
    // `resolveFetchInput` rewrite onto an undeclared private destination
    // before the payload is built (see assertResolvedDestinationDeclared).
    // Without that, classifying the resolved URL here would let the rewrite
    // authorize itself.
    //
    // privateResourceScopes mirrors the task's declared scope from
    // entitlements() below — see urlResourcePattern(input.url) at the task
    // level. Threading it here makes safeFetch re-enforce the same scope on
    // every redirect hop, so a compromised upstream cannot walk across
    // private hosts/ports via Location headers. Least-privilege: the task
    // can only reach the private origin it was specifically authorized for.
    const isPrivate = classification.kind === "private";
    try {
      return await safeFetch(input.url!, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        signal: context.signal,
        allowPrivate: isPrivate,
        privateResourceScopes: isPrivate ? [urlResourcePattern(input.url!)] : undefined,
        sensitiveHeaders: this.sensitiveHeaders,
      });
    } catch (err) {
      if (isFetchUrlJobError(err) || err instanceof AbortSignalJobError) throw err;
      throw wrapFetchUrlNetworkError(input.url!, err);
    }
  }

  /**
   * Streams the response body as `binary-delta` on the `body` port, then a
   * `finish` carrying `metadata` plus whichever derived port `response_type`
   * named. The status is known before the first byte, so a non-2xx throws
   * before any delta is emitted and no downstream consumer is ever dispatched
   * on a doomed fetch.
   *
   * This both calls `context.emitStreamEvent` AND `yield`s every `body`
   * delta. A caller must pick exactly one delivery path: a job context whose
   * `emitStreamEvent` fans out to the same listeners that also drain this
   * generator's yields would double-ship every chunk. The inline `execute()`
   * below is safe because it only drains yields (its context carries no
   * `emitStreamEvent`); a future queued-source caller wiring a worker context
   * through here needs to route through one path, not both.
   *
   * The emitted terminal `finish` is the stream's end-of-stream marker, and
   * awaiting it is what makes it one — by ordering, not by delivery. On the
   * awaited fast path the await covers the dispatch to attached listeners; on
   * the channel path (where that fast path is suppressed and the reassembler's
   * own dispatch is deliberately unawaited) it covers the durable write, which
   * fixes the marker's seq after the last delta's. Nothing can overtake it on
   * either carrier. That is the signal {@link FetchUrlTask.consumeJobStream}
   * ends on, instead of guessing from the job's completion that no more bytes
   * are coming. It
   * carries only `metadata`: the derived port is the *value*, which the
   * settled job output already carries, and duplicating a whole body into the
   * carrier's stream log (where a transferable buffer may be detached out from
   * under the job that still has to return it) buys nothing.
   */
  async *executeStream(
    input: Input,
    context: IJobExecuteContext
  ): AsyncIterable<StreamEvent<Output>> {
    // Before the request, not after: a payload this job cannot produce a result
    // for should not spend a network call, and failing ahead of the first delta
    // keeps the retry rule in `classifyBodyFailure` out of it entirely.
    assertResponseType(input.response_type, input.url!);
    assertMethodAllowsResponseType(input.method, input.response_type, input.url!);

    const response = await this.issueRequest(input, context);
    const metadata = buildMetadata(response);

    if (response.status === 304 && hasConditionalHeader(input.headers)) {
      // No body, no derived port, no delta — so no router opens and no cache
      // ref is minted. The caller reads metadata.notModified and keeps
      // whatever artifact it already had.
      await discardBody(response);
      await this.emitStreamEnd(metadata, context);
      yield { type: "finish", data: { metadata } } as StreamEvent<Output>;
      return;
    }

    if (!response.ok) {
      // No `discardBody` here. `buildHttpError` always calls
      // `readHttpErrorBody`, which cancels its reader in a `finally` — on the
      // byte ceiling, on the read budget, or at EOF — so the socket is already
      // released. With a body there is nothing left to cancel and the stream is
      // still reader-locked, so a second `cancel()` only raises a TypeError for
      // `discardBody` to swallow; with no body it was a no-op to begin with.
      const error = await buildHttpError(input.url!, response);
      throw error;
    }

    if ((input.method ?? "GET").toUpperCase() === "HEAD") {
      // HEAD has no representation body. `response.body` is typically null, and
      // Content-Length describes what a GET would return — not the (empty)
      // bytes we receive. Streaming it would throw NO_RESPONSE_BODY or
      // CONTENT_LENGTH_MISMATCH. Metadata is the whole answer.
      await discardBody(response);
      await this.emitStreamEnd(metadata, context);
      yield { type: "finish", data: { metadata } } as StreamEvent<Output>;
      return;
    }

    const chunks: Uint8Array[] = [];
    const wantsValue = input.response_type !== "stream";
    // Whether a receiver COULD exist, not whether one does: the carrier's
    // subscriber count is not knowable here, and a subscription arriving
    // between a count and the emit would make a retry concatenate onto a
    // partial body. With no `emitStreamEvent` at all there is no subscription
    // to outlive the attempt, so that path retries.
    const deliversDeltas = context.emitStreamEvent !== undefined;
    let emittedDelta = false;
    try {
      for await (const chunk of streamResponseBody(
        response,
        input.url!,
        context.signal,
        async (p) => await context.updateProgress(p)
      )) {
        // `emitStreamEvent` may hand the buffer to a carrier that transfers
        // and detaches it, and a job MUST NOT keep a reference across that
        // call: the accumulated chunk would read back zero-length and the
        // yielded delta would carry detached bytes, so an empty `text`/`json`/
        // `blob` would be reported as a successful fetch. Everything outliving
        // the emit is therefore a copy. With no emit there is nothing to
        // detach, and the original travels as-is.
        const retained = deliversDeltas ? new Uint8Array(chunk) : chunk;
        if (wantsValue) chunks.push(retained);
        // Latched before the emit rather than after it: from the moment a
        // chunk is handed to the consumer this attempt is unrepeatable, and a
        // failure raised during the emit itself is on the far side of that
        // line. See {@link classifyBodyFailure}.
        if (deliversDeltas) emittedDelta = true;
        const emitted = context.emitStreamEvent?.({
          type: "binary-delta",
          port: "body",
          binaryDelta: chunk,
        });
        if (emitted) await emitted;
        yield { type: "binary-delta", port: "body", binaryDelta: retained } as StreamEvent<Output>;
      }
    } catch (err) {
      throw classifyBodyFailure(err, input.url!, emittedDelta);
    }

    let data: Record<string, unknown>;
    try {
      data = {
        ...materializeDerivedPort(input.response_type, chunks, metadata, input.url!),
        metadata,
      };
    } catch (err) {
      // materializeDerivedPort's own INVALID_RESPONSE_TYPE (and any other
      // FetchUrlJobError) is already correctly classified — only an
      // undeclared throw (e.g. JSON.parse's SyntaxError) gets rewrapped here.
      if (isFetchUrlJobError(err)) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw createFetchUrlJobError(
        FetchUrlErrorCode.RESPONSE_PARSE_ERROR,
        `Failed to parse ${input.response_type} response from ${input.url}: ${detail}`,
        { url: input.url }
      );
    }

    await this.emitStreamEnd(metadata, context);
    yield { type: "finish", data } as StreamEvent<Output>;
  }

  /**
   * Publishes the end-of-stream marker to whatever receiver the worker wired
   * up, and waits for it to land. A run with no `emitStreamEvent` delivers to
   * nobody, so there is nothing to mark.
   */
  private async emitStreamEnd(
    metadata: FetchUrlMetadata,
    context: IJobExecuteContext
  ): Promise<void> {
    const emitted = context.emitStreamEvent?.({ type: "finish", data: { metadata } });
    if (emitted) await emitted;
  }

  override async execute(input: Input, context: IJobExecuteContext): Promise<Output> {
    let out: Output | undefined;
    for await (const event of this.executeStream(input, context)) {
      if (event.type === "finish") out = event.data as Output;
    }
    if (out === undefined) {
      throw createFetchUrlJobError(
        FetchUrlErrorCode.RESPONSE_PARSE_ERROR,
        `Fetch of ${input.url} produced no result: the stream ended without a finish payload`,
        { url: input.url }
      );
    }
    return out;
  }
}

const fetchUrlTaskConfigSchema = {
  type: "object",
  properties: {
    ...TaskConfigSchema["properties"],
    queue: {
      oneOf: [{ type: "boolean" }, { type: "string" }],
      description: "Queue handling: false=run inline, true=use default, string=explicit queue name",
      "x-ui-hidden": true,
    },
  },
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type FetchUrlTaskConfig = TaskConfig & {
  queue?: boolean | string;
};

/**
 * Rebuilds the `Error` carried by a stream `error` event. The event may have
 * crossed a serializing carrier, where the `Error` arrives as a plain object
 * (or a bare string), so this never assumes an instance survived the trip — it
 * only guarantees the caller gets something throwable that keeps the reported
 * message.
 */
function toStreamEventError(event: StreamEventLike): Error {
  const raw = (event as { error?: unknown }).error;
  if (raw instanceof Error) return raw;
  if (raw && typeof raw === "object") {
    const message = (raw as { message?: unknown }).message;
    return new Error(typeof message === "string" ? message : JSON.stringify(raw));
  }
  return new Error(raw === undefined ? "Queued fetch reported a stream error" : asText(raw));
}

/**
 * Makes a job's rejection reason throwable.
 *
 * A rejection is not guaranteed to carry an `Error`: a carrier that rebuilds
 * one from an empty persisted column, or a bare `Promise.reject()`, settles
 * with `undefined`. Passing that on reaches `JobTaskFailedError`, which reads
 * `.code` off the reason and would fail with a `TypeError` naming nothing about
 * the fetch — so a reason that says nothing is replaced by one that at least
 * says the job rejected.
 */
function toJobFailure(reason: unknown): unknown {
  if (reason) return reason;
  return new Error(`Queued fetch job rejected without a reason (${String(reason)})`);
}

const UNKNOWN_URL_PRIVATE_ENTITLEMENT: TaskEntitlements = {
  entitlements: [
    {
      id: Entitlements.NETWORK_PRIVATE,
      reason:
        "Runtime URL is not yet available during entitlement evaluation; private/internal destinations must be explicitly allowed",
    },
  ],
};

/**
 * Strings we can classify, or `undefined` to fail closed.
 *
 * A MapTask projection seeds the inner fetch with the whole `url[]` rather
 * than one scalar per iteration. Every entry must be a non-empty string or
 * we cannot tell the destinations apart from unknown and must not under-declare.
 */
function knownFetchUrls(
  url: string | readonly string[] | undefined
): readonly string[] | undefined {
  if (typeof url === "string") {
    return url.length === 0 ? undefined : [url];
  }
  if (!Array.isArray(url) || url.length === 0) return undefined;
  const out: string[] = [];
  for (const item of url) {
    if (typeof item !== "string" || item.length === 0) return undefined;
    out.push(item);
  }
  return out;
}

/**
 * Distinct private origins one declaration will name before it gives up and
 * falls back to the unscoped form. A url array comes from run input, so it can
 * name as many hosts as the caller likes; past this point the scoped list is no
 * longer something a human can review, and "every private destination" is the
 * honest summary of what the run would reach. Staying scoped is a convenience —
 * widening is always safe, narrowing would not be.
 */
export const MAX_PRIVATE_RESOURCE_PATTERNS = 64;

const TOO_MANY_PRIVATE_HOSTS_ENTITLEMENT: TaskEntitlements = {
  entitlements: [
    {
      id: Entitlements.NETWORK_PRIVATE,
      reason:
        `URL list names more than ${MAX_PRIVATE_RESOURCE_PATTERNS} distinct private/internal ` +
        `hosts, too many to declare individually; private/internal destinations must be ` +
        `explicitly allowed`,
    },
  ],
};

/**
 * The `network:private` half of the declaration: one entitlement scoped to the
 * union of the private origins among `urls`, or nothing when none of them is
 * private. Patterns are collected in a set rather than merged pairwise so a
 * long array costs one pass, not one map-and-set rebuild per entry.
 */
function privateNetworkEntitlementFor(urls: readonly string[]): TaskEntitlements {
  const patterns = new Set<string>();
  let reason: string | undefined;
  for (const url of urls) {
    const classification = classifyUrl(url);
    if (classification.kind !== "private") continue;
    patterns.add(urlResourcePattern(url));
    if (patterns.size > MAX_PRIVATE_RESOURCE_PATTERNS) return TOO_MANY_PRIVATE_HOSTS_ENTITLEMENT;
    // First reason wins, matching how `mergeEntitlementPair` folds two of these.
    reason ??= `URL targets private/internal host: ${classification.reason ?? classification.host ?? "unknown"}`;
  }
  if (patterns.size === 0) return { entitlements: [] };
  return {
    entitlements: [
      {
        id: Entitlements.NETWORK_PRIVATE,
        reason: reason!,
        resources: Array.from(patterns),
      },
    ],
  };
}

/**
 * Entitlements a fetch of `url` requires. A task that OWNS a `FetchUrlTask`
 * must declare these itself: the graph snapshot is taken over
 * `graph.getTasks()` before any `execute()` runs, so an owned child created
 * inside `execute()` is never in it.
 *
 * `url` may be unknown at evaluation time (root-task input is not applied
 * yet), in which case this fails closed and requires an unscoped
 * `network:private` rather than under-declaring it. A known array — the shape
 * a MapTask projection leaves on the inner fetch — is classified item by
 * item; any unusable entry fails closed the same way a missing scalar does.
 */
export function fetchUrlEntitlementsFor(
  url: string | readonly string[] | undefined
): TaskEntitlements {
  const base = FetchUrlTask.entitlements();
  const urls = knownFetchUrls(url);
  if (urls === undefined) {
    return mergeEntitlements(base, UNKNOWN_URL_PRIVATE_ENTITLEMENT);
  }
  return mergeEntitlements(base, privateNetworkEntitlementFor(urls));
}

export class FetchUrlTask<
  Input extends FetchUrlTaskInput = FetchUrlTaskInput,
  Output extends FetchUrlTaskOutput = FetchUrlTaskOutput,
  Config extends FetchUrlTaskConfig = FetchUrlTaskConfig,
> extends Task<Input, Output, Config> {
  public static override type = "FetchUrlTask";
  public static override category = "Input";
  public static override title = "Fetch";
  public static override description =
    "Fetches data from a URL with progress tracking and automatic retry handling";
  public static override hasDynamicSchemas: boolean = true;
  public static override hasDynamicEntitlements: boolean = true;

  /**
   * Refuses a subclass that overrides `execute()`.
   *
   * {@link executeStream} is the sole implementation, and `TaskRunner`
   * dispatches a streamable task there — it never calls `execute()`, so an
   * override of it runs on no path a `run()` takes. That silence is the
   * hazard: a subclass overriding `execute()` to derive the real URL from a
   * domain input would have its rewrite skipped and would fetch whatever
   * unresolved `url` the input happened to carry, with no type error and no
   * runtime signal. Failing at construction turns an invisible wrong fetch
   * into an immediate, addressable error.
   *
   * {@link resolveFetchInput} is the supported seam for that rewrite, and it
   * runs on every path.
   */
  constructor(config: NoInfer<Partial<Config>> = {}, runConfig: NoInfer<Partial<IRunConfig>> = {}) {
    super(config, runConfig);
    if (this.execute !== FetchUrlTask.prototype.execute) {
      throw new TaskConfigurationError(
        `${this.type}: overriding execute() on a FetchUrlTask has no effect — a streamable ` +
          `task is dispatched to executeStream(), which does not call execute(). Override ` +
          `resolveFetchInput() to rewrite the request (URL, headers, response_type), or ` +
          `executeStream() to change how the fetch itself runs.`
      );
    }
  }

  /**
   * Belt and braces with {@link assertMethodAllowsResponseType}: the job layer
   * fails closed on a persisted payload, and this fails the same combination at
   * the task layer, before anything is enqueued.
   */
  public override async validateInput(
    input: Input,
    skipPorts?: ReadonlySet<string>
  ): Promise<boolean> {
    const valid = await super.validateInput(input, skipPorts);
    const responseType = input.response_type;
    if (
      responseType !== undefined &&
      responseType !== "stream" &&
      (input.method ?? "GET").toUpperCase() === "HEAD"
    ) {
      throw new TaskInvalidInputError(
        `${this.type}: method HEAD has no response body, so response_type ` +
          `'${responseType}' can never be produced — use 'stream' and read the metadata, ` +
          `or use GET.`
      );
    }
    return valid;
  }

  public static override entitlements(): TaskEntitlements {
    return {
      entitlements: [
        { id: Entitlements.NETWORK_HTTP, reason: "Fetches data from URLs via HTTP/HTTPS" },
        {
          id: Entitlements.CREDENTIAL,
          reason: "May use Bearer token authentication",
          optional: true,
        },
      ],
    };
  }

  /**
   * Dynamic entitlement check: when the configured URL targets a private or
   * loopback host the task additionally requires `network:private`, scoped
   * via the URL's origin so grants can be resource-limited (e.g. a dev-mode
   * grant for `http://localhost:*`). The graph runner evaluates this before
   * `execute()` runs, so a denied private URL never issues a network call.
   */
  public override entitlements(): TaskEntitlements {
    return fetchUrlEntitlementsFor(this.runInputData?.url);
  }

  public static override configSchema(): DataPortSchema {
    return fetchUrlTaskConfigSchema;
  }

  public static override inputSchema() {
    return inputSchema;
  }

  public static override outputSchema() {
    return outputSchema;
  }

  /**
   * Computes output schema dynamically based on the current response_type.
   * `body` and `metadata` are always present; `response_type` additionally
   * narrows in the matching derived port (json/text/blob/arraybuffer).
   */
  public override outputSchema(): DataPortSchema {
    const responseType =
      this.runInputData?.response_type ?? this.defaults?.response_type ?? "stream";
    const staticSchema = (this.constructor as typeof FetchUrlTask).outputSchema();
    if (typeof staticSchema === "boolean" || !staticSchema.properties) return staticSchema;

    const all = staticSchema.properties as Record<string, any>;
    // `body` and `metadata` are unconditional: `body` is the transport for
    // every response type (and the only streaming port, which is what keeps
    // the unflagged cache-sink path available), `metadata` is how a "stream"
    // caller learns what it fetched.
    const properties: Record<string, any> = { body: all.body, metadata: all.metadata };
    if (responseType !== "stream" && all[responseType]) {
      properties[responseType] = all[responseType];
    }

    return { type: "object", properties, additionalProperties: false } as DataPortSchema;
  }

  /**
   * Collects {@link executeStream} into a single value for callers that want
   * one. `isTaskStreamable` is true for this task whenever its dynamic output
   * schema keeps the `x-stream` `body` port, so `TaskRunner` dispatches to
   * `executeStream` and normally never here — making `executeStream` the sole
   * implementation and this a thin drain over it. A second implementation
   * would be dead code that no run or test exercises, so the constructor
   * refuses a subclass that writes one.
   *
   * A `finish` is mandatory: without one there is no output, and returning the
   * `{}` an absent finish leaves behind would hand the caller an object with
   * no `metadata` and no derived port, typed as if the fetch had succeeded.
   */
  override async execute(
    rawInput: FetchUrlTaskInput,
    executeContext: IExecuteContext
  ): Promise<Output> {
    // Resolved here rather than inside the drained generator so the failure
    // message names the request that was actually issued. A subclass whose
    // input is a domain key carries no `url` at all, which is exactly the
    // shape this seam exists for — reporting "for the request" for it says
    // nothing.
    const input = await this.resolveFetchInput(rawInput, executeContext);
    let out: Output | undefined;
    for await (const event of this.streamResolved(input, executeContext)) {
      if (event.type === "finish") out = event.data as Output;
    }
    if (out === undefined) {
      throw new TaskFailedError(
        `FetchUrlTask: the fetch stream ended without a finish payload, so there is no output ` +
          `for ${input.url ?? "the request"}`
      );
    }
    return out;
  }

  /**
   * Resolves the request this run will actually issue. The default returns
   * `input` unchanged; a subclass whose input is a domain key (a CIK, an
   * accession number) rather than a `url` overrides this to build the request
   * from it.
   *
   * Runs first in {@link executeStream} — ahead of the conditional-request
   * guard, so the guard inspects the headers that will really be sent — and
   * everything downstream (default queue name, credential refusal, the job
   * payload handed to the queue) reads the value returned here.
   *
   * SECURITY: {@link entitlements} is evaluated against the UNRESOLVED input,
   * so a rewrite is invisible to it — a resolver returning a private/internal
   * destination declares no `network:private` and would be granted none. The
   * resolved destination is therefore re-checked against that declaration (see
   * {@link assertResolvedDestinationDeclared}) and a rewrite onto an
   * undeclared private host fails closed. Keep the private origins a subclass
   * can produce inside the origin its declared input already names, declare
   * the private input up front, or opt in through
   * {@link allowsPrivateResolution} when the input names no url at all.
   */
  protected async resolveFetchInput(
    input: FetchUrlTaskInput,
    context: IExecuteContext
  ): Promise<FetchUrlTaskInput> {
    void context;
    return input;
  }

  /**
   * Whether {@link resolveFetchInput} may return a private/internal
   * destination when the unresolved input names no url to scope it against.
   *
   * Default `false`. A domain-key input (a CIK, an accession number) carries
   * no url, so {@link entitlements} can only declare an UNSCOPED
   * `network:private` — a declaration covering every private destination, and
   * one that is enforced solely when `enforceEntitlements` is set, which it is
   * not by default. Nothing else states which private host such a resolver is
   * entitled to, so the default answer is none.
   *
   * Returning `true` makes the resolver itself the trust boundary: it may then
   * reach any private host, and the redirect scope `safeFetch` enforces is
   * whichever origin the resolver chose.
   */
  protected allowsPrivateResolution(): boolean {
    return false;
  }

  /**
   * Fails closed when {@link resolveFetchInput} rewrote the request onto a
   * private/internal destination outside what {@link entitlements} declared.
   *
   * The declaration is computed from the unresolved `runInputData.url`, while
   * `FetchUrlJob.issueRequest` classifies the RESOLVED url and passes
   * `allowPrivate` on the strength of that classification. Left alone, the
   * rewrite authorizes itself: a task declaring only `network:http` reaches
   * `http://127.0.0.1/...` with `allowPrivate: true`, and the redirect-scope
   * enforcement inside `safeFetch` is handed the rewritten origin as its own
   * scope. The private-network decision has to follow what was declared, so
   * anything the declaration does not cover is refused before a request is
   * issued (inline and queued alike — the resolved input is what gets
   * enqueued).
   *
   * A task whose url is unavailable at declaration time declares an unscoped
   * `network:private` (see {@link entitlements}), so there is no declared scope
   * here to measure the resolved destination against. That is not a reason to
   * permit it: the unscoped declaration is fail-closed only where it is
   * enforced, and `enforceEntitlements` on `IRunConfig` defaults to **false**.
   * A subclass whose input is a domain key rather than a url — the shape
   * {@link resolveFetchInput} exists for — would otherwise resolve onto any
   * private/internal destination and reach it with `allowPrivate: true` on the
   * default path, which is the same self-authorizing rewrite the declared-url
   * branch refuses. Such a resolution is therefore refused too, unless the
   * subclass declares itself the trust boundary via
   * {@link allowsPrivateResolution}.
   */
  private assertResolvedDestinationDeclared(resolved: FetchUrlTaskInput): void {
    const url = resolved.url;
    if (typeof url !== "string" || url.length === 0) return;
    if (classifyUrl(url).kind !== "private") return;

    const declaredUrl = this.runInputData?.url;
    if (typeof declaredUrl !== "string" || declaredUrl.length === 0) {
      if (this.allowsPrivateResolution()) return;
      throw new TaskEntitlementError(
        `${this.type}: resolveFetchInput rewrote the request onto the private/internal ` +
          `destination ${urlResourcePattern(url)}, and the task's input names no url to scope ` +
          `that against — entitlements are evaluated against the unresolved input, so the only ` +
          `network:private declaration available covers every private destination and is ` +
          `enforced only when enforceEntitlements is set. Declare the private destination on ` +
          `the task input, or override allowsPrivateResolution() to return true if this ` +
          `resolver is trusted to choose private destinations.`
      );
    }
    if (
      classifyUrl(declaredUrl).kind === "private" &&
      urlMatchesScope(url, [urlResourcePattern(declaredUrl)])
    ) {
      return;
    }
    throw new TaskEntitlementError(
      `${this.type}: resolveFetchInput rewrote the request onto the private/internal ` +
        `destination ${urlResourcePattern(url)}, which the task never declared — entitlements ` +
        `are evaluated against the unresolved input (${urlResourcePattern(declaredUrl)}), so ` +
        `no network:private grant covers it. Declare the private destination on the task input, ` +
        `or resolve within the declared origin.`
    );
  }

  /**
   * Runs the fetch, either inline or through a job queue depending on the
   * `queue` config, and yields the body as `binary-delta` events on `body`
   * followed by a `finish`. Credential resolution is handled by the input
   * resolver system — credential_key arrives already resolved to the secret.
   *
   * Invariant, scoped to PERSISTENCE: a resolved secret is never written
   * anywhere durable. Job queues persist their payloads (SQLite/Postgres/SQS),
   * so the secret is only ever placed on the in-process request headers of the
   * inline path, and the queued path refuses to run at all when a credential is
   * present.
   *
   * It does leave this method over the wire, which is a different question. The
   * request carries it to the origin the caller named, and if that origin
   * redirects, `safeFetch` follows the chain — dropping `Authorization` /
   * `Cookie` / `Proxy-Authorization` on any hop that crosses origins, plus
   * whatever {@link FetchUrlJob.sensitiveHeaders} names for the `header`
   * scheme, whose header is caller-chosen and unrecognizable otherwise. A
   * stripped header stays stripped for the rest of the chain, so a
   * vendor -> attacker -> vendor redirect cannot launder it back.
   */
  // No `override`: `executeStream` is an optional member of ITask, not a
  // declared member of Task, so marking it override fails TS4113.
  async *executeStream(
    rawInput: FetchUrlTaskInput,
    executeContext: IExecuteContext
  ): AsyncIterable<StreamEvent<Output>> {
    const input = await this.resolveFetchInput(rawInput, executeContext);
    yield* this.streamResolved(input, executeContext);
  }

  /**
   * Everything after {@link resolveFetchInput}. Split out so `execute()` can
   * resolve once and still report the resolved request, rather than resolving
   * a second time (the seam is a subclass hook and may not be idempotent).
   */
  private async *streamResolved(
    input: FetchUrlTaskInput,
    executeContext: IExecuteContext
  ): AsyncIterable<StreamEvent<Output>> {
    this.assertResolvedDestinationDeclared(input);

    // A 304 carries no body, so a cache save would write a row whose `body` is
    // empty — destroying the cached copy the 304 just certified as still good,
    // and then serving that emptiness back to every later run while the origin
    // moves on. Making that safe means reading the stored validator and
    // reissuing, which is a conditional-cache feature. Conditional requests are
    // for callers managing their own artifact.
    if (hasConditionalHeader(input.headers) && this.hasOutputCache(executeContext)) {
      throw new TaskConfigurationError(
        "FetchUrlTask: a conditional request (If-None-Match / If-Modified-Since) cannot be " +
          "combined with an output cache — a 304 has no body and the save would overwrite the " +
          "cached copy the 304 just validated. Remove the output cache, or drop the validator."
      );
    }

    const credential = input.credential_key;
    const queuePref = this.config.queue ?? false;

    // Ordered before anything that could enqueue: `prepareJobInput` bakes the
    // resolved secret into `headers`, and a queued payload is written to
    // durable storage. Refuse rather than silently downgrading to the inline
    // path, which would quietly drop the queue's rate limiting — the reason the
    // caller asked for a queue in the first place.
    if (credential && queuePref !== false) {
      throw new TaskConfigurationError(
        "FetchUrlTask: credential_key cannot be combined with the queued path (config.queue), " +
          "because queued job payloads are persisted to durable storage. Remove config.queue to " +
          "run inline, or have the queue worker supply the credential itself."
      );
    }

    const jobInput = this.prepareJobInput(input);

    if (queuePref === false) {
      const job = new FetchUrlJob<FetchUrlTaskInput, Output>({ input: jobInput });
      // The header the credential landed on, so safeFetch can drop it when a
      // redirect crosses origins. Only the `header` scheme needs telling: the
      // others write Authorization, which is always stripped cross-origin.
      // Inline-only by construction — the refusal above means a credential and
      // the queued path never coexist, so there is no queued case to carry.
      const credentialScheme = input.credential_scheme ?? DEFAULT_CREDENTIAL_SCHEME;
      job.sensitiveHeaders =
        credential && credentialScheme !== CredentialSchemes.NONE
          ? [credentialHeaderName(credentialScheme, input.credential_header)]
          : undefined;
      try {
        yield* job.executeStream(jobInput, {
          signal: executeContext.signal,
          updateProgress: executeContext.updateProgress.bind(executeContext),
        }) as AsyncIterable<StreamEvent<Output>>;
      } catch (err: any) {
        throw new JobTaskFailedError(err);
      }
      return;
    }

    const queueName =
      typeof queuePref === "string" ? queuePref : await this.getDefaultQueueName(input);
    if (!queueName) {
      throw new TaskConfigurationError("FetchUrlTask: Unable to determine queue name");
    }

    let cleanup: () => void = () => {};
    let onAbort: (() => void) | undefined;
    try {
      const registeredQueue = await this.resolveOrCreateQueue(queueName);

      // Bail early to avoid enqueuing work that has already been cancelled.
      if (executeContext.signal.aborted) {
        throw executeContext.signal.reason ?? new AbortSignalJobError("The operation was aborted");
      }

      const handle = await registeredQueue.client.send(jobInput as Input, {
        jobRunId: this.runConfig.runnerId,
        maxAttempts: 10,
      });

      onAbort = () => {
        handle.abort().catch((err) => {
          console.warn(`Failed to abort queued fetch job`, err);
        });
      };
      executeContext.signal.addEventListener("abort", onAbort);

      cleanup = handle.onProgress(
        (progress: number, message: string | undefined, details: Record<string, any> | null) => {
          executeContext.updateProgress(progress, message, details).catch((error: unknown) => {
            getLogger().warn("Failed to report fetch progress", { error });
          });
        }
      );

      if (executeContext.signal.aborted) {
        throw executeContext.signal.reason ?? new AbortSignalJobError("The operation was aborted");
      }

      // A carrier that gave back no event channel publishes no deltas — no
      // durable queue storage implements `subscribeToStream` — so the job's
      // settled output is the whole delivery and becomes the `finish` this
      // generator owes its consumer. A derived-port response (`response_type`
      // other than "stream") travels intact that way.
      //
      // A "stream" run's bytes do not travel at all: the job's finish payload
      // carries `metadata` alone and there is no delta to accumulate `body`
      // from, so passing it through would report a successful fetch whose body
      // is empty. Refuse instead — a body silently replaced by nothing is the
      // one failure this path must not produce.
      if (typeof handle.onStream !== "function") {
        if (input.response_type === "stream") {
          throw new TaskConfigurationError(
            `FetchUrlTask: the queue serving ${queueName} hands back no stream channel, so a ` +
              `streaming body cannot cross the process boundary — response_type "stream" would ` +
              `yield an empty body. Use a materializing response_type (text/json/blob/` +
              `arraybuffer), which travels in the job's settled output, or run the worker ` +
              `in-process so the client is attached to it.`
          );
        }
        yield { type: "finish", data: await handle.waitFor() } as StreamEvent<Output>;
        return;
      }

      yield* this.consumeJobStream(handle, input.response_type === "stream");
    } catch (err: any) {
      throw new JobTaskFailedError(err);
    } finally {
      if (onAbort) executeContext.signal.removeEventListener("abort", onAbort);
      cleanup();
    }
  }

  /**
   * Adapts `handle.onStream`'s pushed callbacks into the pulled async iterable
   * `executeStream` has to be.
   *
   * **Where the listener promise actually paces the worker.** It resolves only
   * once the event it carried has been pulled off this generator, and on the
   * channel-less fast path that reaches the producer: `JobQueueClient`'s
   * `handleJobStream` awaits every listener, the worker awaits that dispatch,
   * and a slow sink therefore parks the job mid-body. When a stream *channel*
   * subscription is open for the job the fast path is suppressed and the
   * channel replays the row with its dispatch deliberately unawaited (the
   * event is already durably published, so on a cross-process carrier there is
   * no live producer left to pace) — nothing on that path observes this
   * promise, so the worker runs ahead of the consumer no matter what this
   * method does.
   *
   * Nothing here bounds what a fire-and-forget carrier can hand over: the
   * events it has already delivered sit in `pending`, and its own log holds
   * whatever it published. Backpressure across the job boundary exists only
   * where the dispatch is awaited, and no queue this side keeps can create it.
   *
   * **What ends the loop.** `FetchUrlJob` emits a terminal `finish` and awaits
   * it. That await buys ordering rather than delivery: on the fast path it
   * covers the dispatch to attached listeners, and on the channel path the
   * durable write, which fixes the marker's seq after the last delta's. Either
   * way nothing can overtake it, so a marker arriving here means every delta
   * ahead of it already did — the body is whole. The loop ends there. The job's
   * settled output remains the authority for the *value*, so the marker is
   * released without being re-yielded: `waitFor()` produces the one `finish`,
   * and the two can never disagree or arrive twice.
   *
   * Settlement is the fallback for a stream that produces no marker — a failed
   * job (`waitFor()` rejects and there is nothing more to wait for), or a
   * carrier that dropped the terminal row. Because the completion signal and
   * the stream are independent transports, ending there immediately would drop
   * an event still in flight, which on a body port is silent truncation. So a
   * settled stream keeps taking turns of the event loop for as long as each
   * turn actually drains something, and ends on the first turn that does not.
   * A residual remains for that fallback alone: an event landing more than one
   * idle turn after the last, on a carrier that does not deliver the marker
   * *within that turn*, is still lost. Delivering both a moment after the
   * grace turn is spent does not save it — the loop is already gone, so the
   * marker has nothing left to end.
   *
   * An `error` event is not decoration on any of this: it is the only in-band
   * report of a failure the completion signal may not carry, so it is queued
   * in order and raised as a throw when the consumer reaches it.
   *
   * **`requireStreamDelivery` closes the gap a handle's own capability cannot.**
   * `onStream` is advertised whenever the client has an attached server, which
   * on a durable queue is the *possibility* of delivery rather than a
   * guarantee: the job may be claimed by a worker in another process, whose
   * events never reach here. Which process claims a job is not knowable at
   * `send` time, so the only honest advertise-time answer would be to withhold
   * `onStream` from every durable queue — refusing streaming for the ordinary
   * single-process deployment that works today. The discriminator is available
   * here instead, and it is the terminal marker rather than a delta count: a
   * locally-claimed job always emits it (`FetchUrlJob.executeStream` calls
   * `emitStreamEnd` whenever the context carries `emitStreamEvent`, which
   * `JobQueueWorker.executeJob` supplies unconditionally), even for a 304 or a
   * zero-length body, while a remotely-claimed one produces nothing and this
   * loop exits through its settlement fallback with `streamEnded` false.
   */
  private async *consumeJobStream(
    handle: JobHandle<Output>,
    requireStreamDelivery: boolean
  ): AsyncIterable<StreamEvent<Output>> {
    const pending: Array<{ readonly event: StreamEventLike; readonly release: () => void }> = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let streamEnded = false;
    const notify = (): void => {
      const waiting = wake;
      wake = undefined;
      waiting?.();
    };

    const unsubscribe = handle.onStream!((event: StreamEventLike) => {
      if (closed) return Promise.resolve();
      if (event.type === "finish") {
        streamEnded = true;
        notify();
        return Promise.resolve();
      }
      let consumed!: () => void;
      const pulled = new Promise<void>((resolve) => {
        consumed = resolve;
      });
      // Pushed synchronously, in the order the carrier delivered: binary
      // deltas are position-dependent and anything that defers admission can
      // only add a way for the order or the timing to go wrong.
      pending.push({ event, release: consumed });
      notify();
      return pulled;
    });

    let settled = false;
    let output: Output | undefined;
    // Rejection is tracked by a flag rather than by the reason's truthiness: a
    // carrier rebuilding an error from an empty persisted column — or a bare
    // `Promise.reject()` — settles with a falsy reason, and reading that as
    // "no failure" would yield an undefined `finish` and report the run as
    // having ended without a payload, hiding the failure behind a wrong
    // diagnosis.
    let failed = false;
    let failure: unknown;
    // Both branches handled, so this never rejects. It is awaited after the
    // loop rather than raced against it: the loop can end on the stream's own
    // marker, before the job has settled, and the value comes from here.
    const settlement = handle.waitFor().then(
      (value) => {
        output = value;
        settled = true;
        notify();
      },
      (err: unknown) => {
        failure = err;
        failed = true;
        settled = true;
        notify();
      }
    );

    try {
      // The first settled check always earns a turn; later ones are earned by
      // having drained something on the previous turn.
      let drainedSinceGraceTurn = true;
      while (true) {
        while (pending.length > 0) {
          const next = pending.shift()!;
          drainedSinceGraceTurn = true;
          try {
            if (next.event.type === "error") throw toStreamEventError(next.event);
            yield next.event as StreamEvent<Output>;
          } finally {
            next.release();
          }
        }
        if (streamEnded) break;
        if (settled) {
          if (!drainedSinceGraceTurn) break;
          drainedSinceGraceTurn = false;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      await settlement;
      if (failed) throw toJobFailure(failure);
      // Ordered after the failure check on purpose: a job that genuinely failed
      // should report its own cause, which is the better diagnosis. This
      // complaint is only for a job that SUCCEEDED while delivering nothing.
      if (requireStreamDelivery && !streamEnded) {
        throw new TaskFailedError(
          `FetchUrlTask: the queue's stream events never reached this process — the job was ` +
            `likely claimed by a worker in another process — so response_type "stream" would ` +
            `report a successful fetch with an empty body. Use a materializing response_type ` +
            `(text/json/blob/arraybuffer), which travels in the job's settled output, a carrier ` +
            `implementing the stream channel, or run the worker in-process.`
        );
      }
      yield { type: "finish", data: output } as StreamEvent<Output>;
    } finally {
      closed = true;
      unsubscribe();
      // An abandoned generator (abort, or a consumer that stopped pulling)
      // would otherwise leave the worker parked forever on a dispatch nobody
      // is going to resolve.
      for (const leftover of pending.splice(0)) leftover.release();
    }
  }

  /**
   * Whether this run will store its output anywhere — the question the
   * conditional-request guard turns on, since a stored bodiless `304` is what
   * destroys the artifact it validated.
   *
   * Two things have to hold for a row to be written, and both are checked.
   *
   * The task has to be cacheable at all. Every write path in `CacheCoordinator`
   * — the row save, and the stream sinks that mint a `CacheRef` for the `body`
   * port — returns early on `task.cacheable`, so a `cacheable: false` instance
   * (or a subclass declaring `static cacheable = false`) can overwrite nothing
   * and the refusal would cost a caller a working conditional request for a
   * hazard that cannot occur.
   *
   * And a cache has to be in play. The run's own resolution is the authority
   * (see {@link IExecuteContext.cacheRegistry}): reading `runConfig.outputCache`
   * alone answered for one of the three ways a cache reaches a run and left the
   * other two — the config passed to `run()`, and a `CACHE_REGISTRY` binding —
   * silently unguarded. Reading it FIRST was wrong in the other direction:
   * `run(input, { outputCache: false })` resolves no cache, and the instance
   * field it overrides would still have refused the run. A context that went
   * through a runner always carries the `cacheRegistry` key, `undefined`
   * included, so the resolution answers whenever there is one; the legacy field
   * speaks only for a hand-built context, which has no resolution to consult.
   */
  private hasOutputCache(context: IExecuteContext): boolean {
    if (!this.cacheable) return false;
    if ("cacheRegistry" in context) {
      const resolved = context.cacheRegistry;
      return resolved?.deterministic !== undefined || resolved?.private !== undefined;
    }
    return Boolean(this.runConfig.outputCache);
  }

  private prepareJobInput(input: FetchUrlTaskInput): FetchUrlTaskInput {
    const credential = input.credential_key;
    const {
      credential_key: _omitCredential,
      credential_scheme: _omitScheme,
      credential_header: _omitHeader,
      ...rest
    } = input;
    const headers = applyCredentialToHeaders({
      headers: input.headers,
      credential,
      scheme: input.credential_scheme,
      headerName: input.credential_header,
    });
    return headers ? { ...rest, headers } : rest;
  }

  private async resolveOrCreateQueue(queueName: string): Promise<RegisteredQueue<Input, Output>> {
    const registry = getTaskQueueRegistry();
    let registeredQueue = registry.getQueue<Input, Output>(queueName);

    if (!registeredQueue) {
      const factory = getJobQueueFactory();
      registeredQueue = await factory({
        queueName,
        jobClass: FetchUrlJob as any,
        config: this.config,
        task: this,
      });

      try {
        registry.registerQueue(registeredQueue);
      } catch (err) {
        if (err instanceof Error && err.message.includes("already exists")) {
          const existing = registry.getQueue<Input, Output>(queueName);
          if (existing) {
            // Another concurrent call won the race. Stop the server we just
            // created (safe no-op if not yet started) and use the winner's queue.
            registeredQueue.server.stop().catch((stopErr) => {
              console.warn("FetchUrlTask: failed to stop raced-out queue server", stopErr);
            });
            registeredQueue = existing;
          }
        } else {
          throw err;
        }
      }
    }

    if (!registeredQueue.server.isRunning()) {
      await registeredQueue.server.start();
    }

    return registeredQueue;
  }

  /**
   * Detects when response_type changes and emits schemaChange so consumers
   * see the dynamic output schema update.
   */
  public override setInput(input: Partial<Input>): void {
    if (!("response_type" in input)) {
      super.setInput(input);
      return;
    }

    const getCurrentResponseType = () => {
      return this.runInputData?.response_type ?? this.defaults?.response_type ?? "stream";
    };

    const previousResponseType = getCurrentResponseType();

    super.setInput(input);

    const newResponseType = getCurrentResponseType();

    if (previousResponseType !== newResponseType) {
      this.emitSchemaChange();
    }
  }

  private async getDefaultQueueName(input: FetchUrlTaskInput): Promise<string | undefined> {
    if (!input.url) {
      return `fetch:${this.type}`;
    }
    try {
      const hostname = new URL(input.url).hostname.toLowerCase();
      const parts = hostname.split(".").filter(Boolean);
      if (parts.length === 0) {
        return `fetch:${this.type}`;
      }
      const domain = parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
      return `fetch:${domain}`;
    } catch {
      return `fetch:${this.type}`;
    }
  }
}

export const fetchUrl = async (
  input: FetchUrlTaskInput,
  config: FetchUrlTaskConfig = {}
): Promise<FetchUrlTaskOutput> => {
  const result = await new FetchUrlTask(config).run(input);
  return result as FetchUrlTaskOutput;
};

declare module "@workglow/task-graph" {
  interface Workflow {
    fetch: CreateWorkflow<FetchUrlTaskInput, FetchUrlTaskOutput, FetchUrlTaskConfig>;
  }
}

Workflow.prototype.fetch = CreateWorkflow(FetchUrlTask);
