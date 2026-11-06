/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TaskEntitlement, TaskEntitlements } from "@workglow/task-graph";
import {
  classifyUrl,
  Entitlements,
  TaskEntitlementError,
  TaskInvalidInputError,
  urlResourcePattern,
} from "@workglow/task-graph";

/**
 * What a browser task may reach, held to the same rules `FetchUrlTask` and
 * `FileLoaderTask` apply. A browser is the widest reach in the repo — whatever
 * page it opens, the extract and screenshot tasks hand back — so a destination is
 * classified and declared like a fetch, and a local file is contained like a load.
 */

/** Schemes a navigation may target. `about:blank` is how a session is reset. */
const NAVIGABLE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * Refuses a destination a browser task must not open: anything that is not
 * http(s) (`file:` reads the local disk, `data:` and `javascript:` run whatever the
 * graph wrote) except `about:blank`. A relative url resolves against the open page
 * and is allowed; its host is classified at run time by the entitlement check.
 */
export function assertNavigableUrl(url: string, taskType: string): void {
  if (/^about:blank$/i.test(url.trim())) return;
  let parsed: URL;
  try {
    parsed = new URL(url, "https://relative.invalid");
  } catch {
    throw new TaskInvalidInputError(`${taskType}: not a valid url: ${url}`);
  }
  if (!NAVIGABLE_PROTOCOLS.has(parsed.protocol)) {
    throw new TaskInvalidInputError(
      `${taskType}: ${parsed.protocol} urls are not allowed; only http(s) and about:blank`
    );
  }
}

function isAbsoluteHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/**
 * `browser:navigate` scoped to the destination, plus `network:private` when that
 * destination is private — the declaration `FetchUrlTask` makes for the same url.
 * A destination not known yet (no input, or a relative url whose host is the open
 * page's) fails closed: both are declared unscoped, which only a broad grant covers.
 */
export function navigationEntitlements(url: unknown, reason: string): TaskEntitlements {
  if (typeof url !== "string" || url.length === 0 || !isAbsoluteHttpUrl(url)) {
    if (typeof url === "string" && /^about:blank$/i.test(url.trim())) {
      return { entitlements: [{ id: Entitlements.BROWSER_CONTROL_NAVIGATE, reason }] };
    }
    return {
      entitlements: [
        { id: Entitlements.BROWSER_CONTROL_NAVIGATE, reason },
        {
          id: Entitlements.NETWORK_PRIVATE,
          reason:
            "Destination is not known before the run; private/internal hosts must be explicitly allowed",
        },
      ],
    };
  }
  const pattern = urlResourcePattern(url);
  const entitlements: TaskEntitlement[] = [
    { id: Entitlements.BROWSER_CONTROL_NAVIGATE, reason, resources: [pattern] },
  ];
  const classification = classifyUrl(url);
  if (classification.kind === "private") {
    entitlements.push({
      id: Entitlements.NETWORK_PRIVATE,
      reason: `URL targets private/internal host: ${
        classification.reason ?? classification.host ?? "unknown"
      }`,
      resources: [pattern],
    });
  }
  return { entitlements };
}

/** `filesystem:read` scoped to each path, or unscoped while the paths are unknown. */
export function uploadEntitlements(filePaths: unknown): TaskEntitlements {
  const reason = "Reads local files for upload to browser";
  const known =
    Array.isArray(filePaths) &&
    filePaths.length > 0 &&
    filePaths.every((p) => typeof p === "string" && p.length > 0);
  return {
    entitlements: [
      known
        ? { id: Entitlements.FILESYSTEM_READ, reason, resources: filePaths as string[] }
        : { id: Entitlements.FILESYSTEM_READ, reason },
    ],
  };
}

// Built at run time so no bundler resolves them: a literal (even a concatenated one,
// which bundlers fold) would be followed into a browser build that has no `node:fs`.
const NODE_FS = ["node", "fs"].join(":");
const NODE_PATH = ["node", "path"].join(":");

export interface UploadContainment {
  readonly roots?: readonly string[] | undefined;
  readonly allowAnyRoot?: boolean | undefined;
}

/**
 * Resolves each path (symlinks included) and refuses one outside the roots —
 * `FileLoaderTask`'s rule, defaulting to the process working directory. Node's
 * fs and path are loaded here rather than imported, because this package is also
 * bundled for the browser; an upload only ever executes on a server backend.
 */
export async function containUploadPaths(
  filePaths: readonly string[],
  { roots, allowAnyRoot }: UploadContainment
): Promise<string[]> {
  const fs = (await import(/* @vite-ignore */ NODE_FS)) as typeof import("node:fs");
  const path = (await import(/* @vite-ignore */ NODE_PATH)) as typeof import("node:path");
  const realOf = (p: string): string => {
    const resolved = path.resolve(p);
    try {
      return fs.realpathSync(resolved);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
    }
  };
  const real = filePaths.map(realOf);
  if (allowAnyRoot === true) return real;
  const configured = roots ?? [process.cwd()];
  const realRoots = configured.map((root) => {
    try {
      return fs.realpathSync(root);
    } catch (err) {
      throw new TaskInvalidInputError(
        `Configured root ${root} could not be resolved: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  });
  for (const p of real) {
    const inside = realRoots.some((root) => p === root || p.startsWith(root + path.sep));
    if (!inside) {
      throw new TaskEntitlementError(
        `Upload path ${p} is outside the configured roots: ${configured.join(", ")}`
      );
    }
  }
  return real;
}
