/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskConfigurationError } from "@workglow/task-graph";

/**
 * How a resolved credential is placed onto the outbound request.
 *
 * - `bearer` — `Authorization: Bearer <secret>` (default; OAuth 2.0 style)
 * - `basic`  — `Authorization: Basic <secret>`; the secret is used verbatim and
 *   must already be the base64 of `user:pass`. Nothing is encoded here, so a
 *   caller keeps full control over how the pair is assembled.
 * - `header` — the raw secret as the value of {@link credentialHeaderName}
 *   (API-key style, e.g. `X-Api-Key`)
 * - `none`   — the credential is resolved but never placed on the request
 */
export const CredentialSchemes = {
  BEARER: "bearer",
  BASIC: "basic",
  HEADER: "header",
  NONE: "none",
} as const;

export type CredentialScheme = (typeof CredentialSchemes)[keyof typeof CredentialSchemes];

export const DEFAULT_CREDENTIAL_SCHEME: CredentialScheme = CredentialSchemes.BEARER;
export const DEFAULT_CREDENTIAL_HEADER = "Authorization";

/**
 * Header names are restricted to RFC 7230 token characters that survive every
 * transport unambiguously. The narrow allow-list is deliberate: it rejects the
 * CR/LF, colon, and whitespace that would otherwise let a configured header
 * name inject additional headers into the request.
 */
const CREDENTIAL_HEADER_NAME_PATTERN = /^[A-Z0-9-]{1,64}$/i;

/**
 * Whether `name` is a bare header token by the rule above.
 *
 * Exported so a caller validating request headers of its own applies the SAME
 * rule the credential ports are held to, rather than a second spelling of it.
 * The pattern itself stays private — it is a `g`-less but still shared `RegExp`,
 * and a predicate cannot be re-pointed at a different one by accident.
 */
export function isBareHeaderName(name: string): boolean {
  return CREDENTIAL_HEADER_NAME_PATTERN.test(name);
}

export interface ApplyCredentialOptions {
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly credential: string | undefined;
  readonly scheme: CredentialScheme | undefined;
  readonly headerName: string | undefined;
}

/**
 * Returns the header name a scheme writes to, after validating any caller-supplied
 * name. Validation runs even for schemes that ignore `headerName` so a malformed
 * value is reported rather than silently discarded.
 *
 * @throws {TaskConfigurationError} when `headerName` is not a bare header token.
 */
export function credentialHeaderName(
  scheme: CredentialScheme,
  headerName: string | undefined
): string {
  if (headerName !== undefined && !isBareHeaderName(headerName)) {
    throw new TaskConfigurationError(
      `FetchUrlTask: invalid credential_header ${JSON.stringify(headerName)}. ` +
        "Header names must be 1-64 characters of letters, digits, or hyphens."
    );
  }
  if (scheme === CredentialSchemes.HEADER) {
    return headerName ?? DEFAULT_CREDENTIAL_HEADER;
  }
  return DEFAULT_CREDENTIAL_HEADER;
}

/**
 * Places a resolved credential onto a copy of `headers` according to `scheme`.
 *
 * Pure: it never reads a credential store and never mutates its arguments. A
 * resolved credential wins over a same-named header the caller supplied — the
 * credential store is the authoritative source, and letting a hard-coded header
 * shadow it would silently defeat the configured credential.
 *
 * The override is case-INSENSITIVE, because HTTP header names are. A plain
 * `{ ...headers, Authorization: value }` leaves a caller's `authorization` key
 * in place as a distinct object property, and the `Headers` constructor then
 * folds the two into one comma-joined field — sending the caller's stale token
 * alongside the real one and breaking the request.
 *
 * @throws {TaskConfigurationError} when `headerName` is not a bare header token.
 */
export function applyCredentialToHeaders(
  options: ApplyCredentialOptions
): Record<string, string> | undefined {
  const { headers, credential, headerName } = options;
  const scheme = options.scheme ?? DEFAULT_CREDENTIAL_SCHEME;

  // Validated unconditionally: a bad header name is a configuration error even
  // when the active scheme would not have used it.
  const name = credentialHeaderName(scheme, headerName);

  if (!credential || scheme === CredentialSchemes.NONE) {
    return headers ? { ...headers } : headers;
  }

  const value =
    scheme === CredentialSchemes.BEARER
      ? `Bearer ${credential}`
      : scheme === CredentialSchemes.BASIC
        ? `Basic ${credential}`
        : credential;

  const lowerName = name.toLowerCase();
  const result: Record<string, string> = {};
  for (const [key, existing] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === lowerName) continue;
    result[key] = existing;
  }
  result[name] = value;
  return result;
}
