/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// The guards moved to `@workglow/util` so a second server could share them
// rather than copy them; this path stays for the callers that import it.
export type { BearerAuthFailure } from "@workglow/util";
export {
  authorizeBearer,
  bearerTokenMatches,
  generateBearerToken,
  readBearerToken,
} from "@workglow/util";
