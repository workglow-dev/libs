/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskEntitlementError, TaskInvalidInputError } from "@workglow/task-graph";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface LocalFilePathOptions {
  /**
   * Directories the path must resolve inside, checked after symlinks are
   * resolved. Omitting it means `[process.cwd()]` — NOT "anywhere on the
   * host".
   *
   * The entitlement is not a substitute for this. `filesystem:read` is only
   * consulted when the embedder BOTH runs the graph with
   * `enforceEntitlements` AND registers an `ENTITLEMENT_ENFORCER` (the token
   * has no default factory, so setting the flag without one throws). Neither
   * is the default, so an unconfigured host that treated an absent `roots` as
   * unrestricted was readable end to end by any graph naming these tasks.
   *
   * An empty array is a deliberate "no path is readable" and is honored as
   * written.
   */
  readonly roots?: readonly string[] | undefined;
  /**
   * Skip containment altogether. Only the literal `true` does so: it is the
   * explicit "this process may read any path it can open" statement an
   * embedder makes for itself, and it is never implied by leaving `roots`
   * unset.
   */
  readonly allowAnyRoot?: boolean | undefined;
}

/** True for an http(s) URL, case-insensitively — `HTTP://x` is an http URL. */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function fileUrlToPath(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TaskInvalidInputError(`Invalid file URL: ${url}`);
  }
  try {
    // Percent-decodes, rejects a non-empty non-localhost host, and yields
    // `C:\x` rather than `/c:/x` on Windows.
    return fileURLToPath(parsed);
  } catch (err) {
    throw new TaskInvalidInputError(
      `Invalid file URL: ${url} (${err instanceof Error ? err.message : String(err)})`
    );
  }
}

/**
 * The filesystem path a local-file input names, with a `file:` scheme decoded
 * away and nothing else done to it — no `resolve`, no `realpath`, no
 * containment. It is the path as the CALLER wrote it, for reporting and for
 * extension sniffing; {@link resolveLocalFilePath} is what an open must use.
 */
export function localFilePathFromUrl(url: string): string {
  return /^file:/i.test(url) ? fileUrlToPath(url) : url;
}

/**
 * Real, absolute path for a local-file input, contained within `roots`.
 *
 * Order matters: the containment check runs AFTER `realpathSync`, so a symlink
 * pointing out of a root is caught rather than followed. Callers must open the
 * returned path, not the one they passed in.
 *
 * Every configured root is resolved BEFORE any containment verdict is taken,
 * so an unresolvable root fails the call wherever it sits in the array. Doing
 * it inside the `some()` predicate made the outcome depend on array order —
 * `["good", "missing"]` succeeded because `some` short-circuited before
 * reaching the broken root, while `["missing", "good"]` threw on identical
 * input.
 *
 * Residual TOCTOU: a component of the path can be swapped between this
 * resolution and the open that follows it. Closing that needs an
 * openat-with-fd-relative walk, which Node does not expose.
 */
export function resolveLocalFilePath(url: string, options: LocalFilePathOptions = {}): string {
  const raw = localFilePathFromUrl(url);
  const resolved = resolve(raw);

  let real: string;
  try {
    real = realpathSync(resolved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // A missing file still gets a real DIRECTORY path, so containment is
    // decided on resolved ground; the open below then fails with ENOENT as it
    // always did.
    real = join(realpathSync(dirname(resolved)), basename(resolved));
  }

  const { roots, allowAnyRoot } = options;
  if (allowAnyRoot !== true) {
    const configured = roots ?? [process.cwd()];
    // A root that cannot be resolved is a misconfiguration, and saying which
    // one beats an `ENOENT ... lstat` raised from inside the containment
    // check. It is deliberately NOT treated as "does not contain the path":
    // that reads as a containment verdict on evidence nobody has.
    const realRoots = configured.map((root) => {
      try {
        return realpathSync(root);
      } catch (err) {
        throw new TaskInvalidInputError(
          `Configured root ${root} could not be resolved: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    });
    // A filesystem root already ends in its separator (`/`, `C:\`); adding another
    // made `//` the prefix, which no path has, so such a root contained nothing.
    const allowed = realRoots.some(
      (realRoot) =>
        real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)
    );
    if (!allowed) {
      throw new TaskEntitlementError(
        `Path ${real} is outside the configured roots: ${configured.join(", ")}`
      );
    }
  }

  // A fifo or a character device (/dev/zero) reads forever with no deadline.
  let stats;
  try {
    stats = statSync(real);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return real;
    throw err;
  }
  if (!stats.isFile()) {
    throw new TaskInvalidInputError(`Not a regular file: ${real}`);
  }

  return real;
}
