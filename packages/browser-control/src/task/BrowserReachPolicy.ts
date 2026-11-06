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
  urlMatchesScope,
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
  // An absolute url the classifier cannot place (credentials in it, no host) cannot be
  // declared by destination, so it is not opened — as a fetch refuses it.
  if (isAbsoluteHttpUrl(url)) {
    const classification = classifyUrl(url);
    if (classification.kind === "invalid") {
      throw new TaskInvalidInputError(
        `${taskType}: ${classification.reason ?? "url cannot be classified"}: ${url}`
      );
    }
  }
}

function isAbsoluteHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** Both declared unscoped: only a broad grant covers a destination not known yet. */
function unknownDestination(reason: string): TaskEntitlements {
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
    return unknownDestination(reason);
  }
  const classification = classifyUrl(url);
  if (classification.kind === "invalid") return unknownDestination(reason);
  const pattern = urlResourcePattern(url);
  const entitlements: TaskEntitlement[] = [
    { id: Entitlements.BROWSER_CONTROL_NAVIGATE, reason, resources: [pattern] },
  ];
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

/**
 * Refuses a page that landed on a private host its navigation did not declare — the
 * check `safeFetch` makes on every redirect hop. Entitlements are declared for the url
 * asked for, and a redirect chooses where the page ends up: without this a public url
 * answering 302 to a metadata endpoint hands that page to the extract and screenshot
 * tasks. A private destination may land anywhere on its declared origin; a relative or
 * unknown one declared `network:private` unscoped, so a broad grant already covered it.
 * Only the landing page is checked: navigations a page makes later, by script or a
 * click, are outside it.
 */
export function assertLandedWithinReach(requested: string, landed: string, taskType: string): void {
  if (!isAbsoluteHttpUrl(landed) || classifyUrl(landed).kind !== "private") return;
  if (!isAbsoluteHttpUrl(requested)) return;
  if (
    classifyUrl(requested).kind === "private" &&
    urlMatchesScope(landed, [urlResourcePattern(requested)])
  ) {
    return;
  }
  throw new TaskEntitlementError(
    `${taskType}: navigating to ${requested} ended at ${landed}, a private host it did not declare`
  );
}

/**
 * `filesystem:read` scoped to the file each path resolves to, or unscoped while the
 * paths are unknown. Declared by real path, as `FileLoaderTask` declares: a grant for
 * a symlink must not cover the file behind it, and the upload reads the real file.
 */
export function uploadEntitlements(filePaths: unknown): TaskEntitlements {
  const reason = "Reads local files for upload to browser";
  const known =
    Array.isArray(filePaths) &&
    filePaths.length > 0 &&
    filePaths.every((p) => typeof p === "string" && p.length > 0);
  return {
    entitlements: [
      known
        ? {
            id: Entitlements.FILESYSTEM_READ,
            reason,
            resources: (filePaths as string[]).map(realPathIfResolvable),
          }
        : { id: Entitlements.FILESYSTEM_READ, reason },
    ],
  };
}

interface NodeFsPath {
  readonly fs: typeof import("node:fs");
  readonly path: typeof import("node:path");
}

/**
 * Node's fs and path where the runtime hands them over synchronously
 * (`process.getBuiltinModule`, Node 22.3+ and Bun) — entitlements are declared
 * synchronously. Undefined in a browser, which never uploads a local file.
 */
function nodeFsPathSync(): NodeFsPath | undefined {
  const getBuiltin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } })
    .process?.getBuiltinModule;
  if (typeof getBuiltin !== "function") return undefined;
  const fs = getBuiltin(NODE_FS) as NodeFsPath["fs"] | undefined;
  const path = getBuiltin(NODE_PATH) as NodeFsPath["path"] | undefined;
  return fs && path ? { fs, path } : undefined;
}

/** The real path a file path resolves to (its directory, if the file does not exist). */
function realPathOf({ fs, path }: NodeFsPath, p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  }
}

function realPathIfResolvable(p: string): string {
  const node = nodeFsPathSync();
  if (!node) return p;
  try {
    return realPathOf(node, p);
  } catch {
    return p;
  }
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
  const real = filePaths.map((p) => realPathOf({ fs, path }, p));
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
    // A filesystem root already ends in a separator (`/`, `C:\\`); adding another
    // made `//` the prefix, which no path has.
    const inside = realRoots.some(
      (root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
    );
    if (!inside) {
      throw new TaskEntitlementError(
        `Upload path ${p} is outside the configured roots: ${configured.join(", ")}`
      );
    }
  }
  return real;
}
