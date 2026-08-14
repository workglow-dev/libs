/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

/** The root `workspaces` globs, in the order a manifest scan walks them. */
const WORKSPACE_GROUPS = ["packages", "providers", "examples"] as const;

/**
 * The conditions a plain `import` from Node activates, and only those.
 *
 * `types` is a compiler artifact, `browser` and `bun` name runtimes this test
 * is not running under, and entering either would import a bundle whose
 * dependencies (DOM globals, `bun:sqlite`) do not exist here. Node's own
 * algorithm is what is replicated: walk the object's keys IN ORDER and take the
 * first one that names an active condition, so a `types`-first block resolves
 * to whatever comes after it rather than to nothing.
 */
const NODE_CONDITIONS: ReadonlySet<string> = new Set(["node", "import", "default"]);

/**
 * Entries no CI job can import, each with the reason it cannot.
 *
 * Kept deliberately small and stated per entry, so a NEW package defaults to
 * being checked: the value of this file is that a published entry nobody
 * imports is a bug, and a permissive default would recreate exactly the hole it
 * closes. Every key is proved to still exist below, so a package that is
 * renamed or deleted takes its exemption with it.
 */
const UNCHECKABLE: Readonly<Record<string, string>> = {
  "@workglow/cli":
    "an example app, and `packages/test` does not depend on it — under bunfig's " +
    "isolated linker the specifier does not resolve from here at all, so importing " +
    "it would test the linker rather than the bundle",
};

/**
 * Entries that load but legitimately export nothing, with the reason.
 *
 * These are still IMPORTED — that a side-effect module evaluates cleanly is the
 * whole of what it promises — only the non-empty assertion is lifted.
 */
const SIDE_EFFECT_ONLY: Readonly<Record<string, string>> = {
  "workglow/auto-bootstrap":
    "registers the bundled providers as an import side effect and exports nothing by design",
};

interface PublishedEntry {
  /** The package that publishes it. */
  readonly packageName: string;
  /** The specifier a consumer writes, e.g. `@workglow/util/schema`. */
  readonly specifier: string;
  /** The manifest-relative target Node resolves it to under `NODE_CONDITIONS`. */
  readonly target: string;
}

/** The target a conditional `exports` value resolves to, or `undefined`. */
function resolveUnderNode(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  for (const [condition, child] of Object.entries(value as Record<string, unknown>)) {
    if (!NODE_CONDITIONS.has(condition)) continue;
    const resolved = resolveUnderNode(child);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/** Every published entry of every workspace package, by manifest. */
function collectPublishedEntries(): PublishedEntry[] {
  const entries: PublishedEntry[] = [];
  for (const group of WORKSPACE_GROUPS) {
    let directories: string[];
    try {
      directories = readdirSync(join(repoRoot, group));
    } catch {
      continue;
    }
    for (const directory of directories) {
      let manifest: { name?: unknown; exports?: unknown };
      try {
        manifest = JSON.parse(
          readFileSync(join(repoRoot, group, directory, "package.json"), "utf8")
        );
      } catch {
        continue; // not a package directory
      }
      const { name, exports } = manifest;
      if (typeof name !== "string") continue;
      if (typeof exports !== "object" || exports === null || Array.isArray(exports)) continue;
      for (const [subpath, value] of Object.entries(exports as Record<string, unknown>)) {
        if (!subpath.startsWith(".")) continue; // a bare condition map, not a subpath
        const target = resolveUnderNode(value);
        if (target === undefined) continue; // browser-only entry; nothing for Node to load
        entries.push({ packageName: name, specifier: name + subpath.slice(1), target });
      }
    }
  }
  return entries.sort((a, b) => a.specifier.localeCompare(b.specifier));
}

const entries = collectPublishedEntries();
const checkable = entries.filter((entry) => !(entry.specifier in UNCHECKABLE));

/**
 * Import every entry this repo publishes, by the specifier a consumer writes.
 *
 * The blocking bundle-integrity check is `test-vitest-dist`, which runs the
 * UNIT tier against the built bundles. That makes the check tier-shaped: an
 * entry reachable only from an `.integration.test.ts` file is exercised by no
 * blocking job at all, which was true of `@workglow/openrouter/ai-runtime` and
 * `@workglow/huggingface-inference/ai-runtime` — a `bun build` change that
 * dropped a re-export from either bundle would have left the file in place,
 * satisfied every existing check, and broken consumers only after publish.
 *
 * Enumerating the manifests instead of the import graph makes the check TOTAL
 * rather than tier-shaped, and it costs nothing under the default target (the
 * same source files the rest of the suite already loads). It is a unit-tier
 * file on purpose: that is the tier `test-vitest-dist` runs.
 *
 * The enumeration is local rather than shared with `scripts/lib/`:
 * `packages/test` is a `composite` project rooted at `./src`, so importing from
 * `scripts/` would put those files in its program and break `build-types`.
 */
describe("published entry imports", () => {
  it("enumerates every workspace manifest, so an empty sweep cannot pass", () => {
    // Anti-vacuity: a typo in the walk (wrong group, wrong key) yields a short
    // list rather than an error, and a short list passes every assertion below.
    expect(entries.length).toBeGreaterThan(60);
    expect(new Set(entries.map((entry) => entry.packageName)).size).toBeGreaterThan(20);
  });

  it("resolves every entry to a built file under dist", () => {
    // Every published entry is a bundle. A target outside `dist` means the
    // manifest ships source, and one that is not `.js` means the walk above
    // landed on a `types` (or other non-runtime) condition.
    const offenders = entries
      .filter((entry) => !/^\.\/dist\/.+\.js$/.test(entry.target))
      .map((entry) => `${entry.specifier} -> ${entry.target}`);
    expect(offenders).toEqual([]);
  });

  it("keeps every exemption pinned to an entry that still exists", () => {
    // An exemption that outlives its package silently exempts nothing, and
    // reads as if a real hole were still open.
    const published = new Set(entries.map((entry) => entry.specifier));
    const stale = [...Object.keys(UNCHECKABLE), ...Object.keys(SIDE_EFFECT_ONLY)].filter(
      (specifier) => !published.has(specifier)
    );
    expect(stale).toEqual([]);
    for (const reason of [...Object.values(UNCHECKABLE), ...Object.values(SIDE_EFFECT_ONLY)]) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it.each(checkable.map((entry) => entry.specifier))("%s loads", async (specifier) => {
    const loaded: Record<string, unknown> = await import(/* @vite-ignore */ specifier);
    expect(loaded).toBeDefined();
    if (specifier in SIDE_EFFECT_ONLY) return;
    // A bundle that lost every re-export still resolves and still evaluates;
    // the export list is the only thing that says the entry point works.
    expect(Object.keys(loaded).length).toBeGreaterThan(0);
  });
});
