/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * **Every workspace moves together.** One version across the whole tree,
 * matched by the workspace root and by the single tag the cut writes, so any
 * two packages a consumer installs are the pair that were built and tested
 * together. The release cut is `--all` for that reason, and this measures the
 * result rather than trusting the flag: a hand-edited version, a half-applied
 * bump, or a cut that quietly ran `--changed` all land here, named one by one.
 *
 * The four never-published workspaces — `@workglow/test`, `@workglow/aws`,
 * `@workglow/cloudflare`, `@workglow/web` — are in the lockstep too, and this
 * guard does not exempt them. Their version buys nothing on its own, but an
 * exception costs more to remember than it saves, and it would leave
 * `@workglow/test` disagreeing with the packages it tests about which release
 * they belong to.
 *
 * `@workglow/test-contract` is the one that left that set. It carries the
 * parameterized conformance suites and nothing else, so an adapter written
 * outside this repo can inherit the same assertions its in-repo siblings run —
 * which it cannot do from a workspace that 404s on npm. The 441 concrete tests
 * stayed behind in `@workglow/test`, which is still private.
 *
 * **What they ARE held out of is publishing, and the two spellings of that
 * have to agree.** `publish-workspaces.ts` keys on
 * `publishConfig.access === "public"`; anything keyed on a package being
 * unreleased reads `private: true`. `examples/web` satisfied the first while
 * carrying no `private` flag, which is the shape that goes wrong quietly, so
 * both directions are pinned here: an unpublished package must be private, and
 * a private one must not be something the publish step would try to ship —
 * `bun publish` refuses a private manifest.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./lib/testDiscovery";

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly publishConfig?: { readonly access?: string };
}

interface Workspace {
  /** Directory relative to the repo root, e.g. `providers/aws`. */
  readonly dir: string;
  readonly manifest: Manifest;
}

function readRootManifest(): {
  readonly version?: string;
  readonly workspaces?: readonly string[];
} {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version?: string;
    workspaces?: readonly string[];
  };
}

/**
 * Every workspace, expanded from the same root `workspaces` globs the release
 * cut's package enumeration walks. Reading the array rather than restating the
 * three group names is the point: a fourth group added there is covered here on
 * the same commit.
 */
function readWorkspaces(): Workspace[] {
  const root = readRootManifest();
  const workspaces: Workspace[] = [];

  for (const pattern of root.workspaces ?? []) {
    const group = pattern.replace(/^\.\//, "").replace(/\/\*$/, "");
    // Only `./group/*` is understood. Anything else would be silently skipped,
    // narrowing the guard without saying so, so make it a failure instead.
    if (group === "" || group.includes("*")) {
      throw new Error(`Unsupported workspace pattern for this guard: ${pattern}`);
    }
    for (const dir of readdirSync(join(ROOT, group))) {
      const abs = join(ROOT, group, dir);
      if (!statSync(abs).isDirectory()) continue;
      let text: string;
      try {
        text = readFileSync(join(abs, "package.json"), "utf8");
      } catch {
        continue;
      }
      workspaces.push({ dir: `${group}/${dir}`, manifest: JSON.parse(text) as Manifest });
    }
  }

  return workspaces.sort((a, b) => a.dir.localeCompare(b.dir));
}

const WORKSPACES = readWorkspaces();
const ROOT_VERSION = readRootManifest().version;
const isPublishable = (w: Workspace): boolean => w.manifest.publishConfig?.access === "public";

describe("workspace versions", () => {
  // The root is the reference because the cut bumps it in the same step it
  // bumps the packages, and it is the one version a reader can check by eye.
  it("are in lockstep with the workspace root", () => {
    const adrift = WORKSPACES.filter((w) => w.manifest.version !== ROOT_VERSION).map(
      (w) => `${w.dir}@${w.manifest.version} (root is ${ROOT_VERSION})`
    );
    expect(adrift).toEqual([]);
  });
});

describe("publishability", () => {
  it("is spelled both ways on every unpublished workspace", () => {
    const notPrivate = WORKSPACES.filter((w) => !isPublishable(w) && w.manifest.private !== true);
    expect(notPrivate.map((w) => w.dir)).toEqual([]);
  });

  it("does not mark anything the publish step ships as private", () => {
    const privatePublishable = WORKSPACES.filter((w) => isPublishable(w) && w.manifest.private);
    expect(privatePublishable.map((w) => w.dir)).toEqual([]);
  });
});
