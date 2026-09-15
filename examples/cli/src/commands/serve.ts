/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { generateBearerToken } from "@workglow/util";

/**
 * The bearer token a served endpoint will require, or `null` for none.
 *
 * A pinned token wins over a generated one because a client config has to hold
 * the same value across restarts, and the environment wins over nothing at all
 * — but only `--no-auth` reaches `null`. Falling through to an
 * unauthenticated server because no token was supplied is exactly the accident
 * this generates one to prevent — so an empty `--token` or an empty variable
 * falls through to a generated token rather than to the empty string, which is
 * why this reads `||` and not `??`.
 *
 * `envName` is the variable a pinned token arrives in, and has no default:
 * each served protocol has its own, and a token meant for one endpoint must
 * never be accepted by another.
 */
export function resolveServeToken(
  opts: { readonly auth: boolean; readonly token?: string },
  envName: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
  if (!opts.auth) return null;
  return opts.token || env[envName] || generateBearerToken();
}

/**
 * Keeps a serving command's action from returning until Ctrl-C.
 *
 * The CLI tears down once an action returns, and a server needs the runtime
 * for as long as it is serving. SIGINT or SIGTERM closes the server, and the
 * promise resolves once it has, so teardown runs once and after it.
 */
export function serveUntilSignal(close: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const shutdown = (): void => {
      console.log("shutting down");
      void close().then(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
