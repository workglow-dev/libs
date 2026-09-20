/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

/**
 * The workspace groups, derived from the root manifest's `workspaces` field.
 *
 * Duplicated derivation code rather than a duplicated list, for the reason
 * `PublishedEntryImports.test.ts` spells out: `packages/test` is a `composite`
 * project rooted at `./src`, so importing the tooling's own copy under
 * `scripts/` would pull those files into its program and break `build-types`.
 */
const WORKSPACE_GROUPS: readonly string[] = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { workspaces: string[] }
).workspaces.map((pattern) => pattern.replace(/^\.\//, "").replace(/\/?\*.*$/, ""));

/**
 * The conditions a plain `import` from Node activates, and only those. Node's
 * own algorithm: walk the keys IN ORDER and take the first active one, so a
 * `types`-first block resolves to whatever follows it rather than to nothing.
 */
const NODE_CONDITIONS: ReadonlySet<string> = new Set(["node", "import", "default"]);

/** Source extensions a built entry can have come from, in resolution order. */
const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;

/**
 * Entries no CI job can import, each with the reason — the same map, for the
 * same entry and the same reason, as `PublishedEntryImports.test.ts`. Kept
 * deliberately small so a NEW package defaults to being checked. Every key is
 * proved below to still name a published entry.
 */
const UNCHECKABLE: Readonly<Record<string, string>> = {
  "@workglow/cli":
    "an example app, and `packages/test` does not depend on it — under bunfig's " +
    "isolated linker the specifier does not resolve from here at all, so importing " +
    "it would test the linker rather than the bundle",
};

interface EntryPair {
  /** The specifier a consumer writes, e.g. `@workglow/util/schema`. */
  readonly specifier: string;
  /** Absolute path of the source module the built entry was built from. */
  readonly sourcePath: string;
}

/** The target a conditional `exports` value resolves to under Node. */
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

/**
 * `<pkg>/dist/<entry>.js` → `<pkg>/src/<entry>.{ts,tsx}` — the inverse of what
 * the build emits, and the same mapping `use-source` writes its stubs from.
 *
 * Re-derived here rather than imported from `scripts/lib/workspaceSource.ts`
 * for the composite-project reason above. Deliberately returns `undefined`
 * rather than guessing for a target with no counterpart (generated or copied
 * build output), so such an entry is reported as skipped instead of failing.
 */
function sourceCounterpart(packageDir: string, target: string): string | undefined {
  const match = /^\.\/dist\/(?<entry>.+)\.(?:js|mjs|cjs)$/.exec(target);
  if (!match?.groups) return undefined;
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = join(packageDir, "src", `${match.groups.entry}${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Every published Node entry that has a source counterpart to compare against. */
function collectEntryPairs(): { pairs: EntryPair[]; unmapped: string[] } {
  const pairs: EntryPair[] = [];
  const unmapped: string[] = [];
  for (const group of WORKSPACE_GROUPS) {
    let directories: string[];
    try {
      directories = readdirSync(join(repoRoot, group));
    } catch {
      continue;
    }
    for (const directory of directories) {
      const packageDir = join(repoRoot, group, directory);
      let manifest: { name?: unknown; exports?: unknown };
      try {
        manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
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
        const specifier = name + subpath.slice(1);
        const sourcePath = sourceCounterpart(packageDir, target);
        if (sourcePath === undefined) {
          unmapped.push(`${specifier} -> ${target}`);
          continue;
        }
        pairs.push({ specifier, sourcePath });
      }
    }
  }
  pairs.sort((a, b) => a.specifier.localeCompare(b.specifier));
  return { pairs, unmapped };
}

const { pairs, unmapped } = collectEntryPairs();
const checkable = pairs.filter((pair) => !(pair.specifier in UNCHECKABLE));

/**
 * Every published entry, imported twice — once by the specifier a consumer
 * writes, once by the source file it was built from — with the export NAME sets
 * compared.
 *
 * Why names, and why both sides: a bundle that lost a re-export still resolves
 * and still evaluates cleanly, so `PublishedEntryImports.test.ts`'s "loads and
 * exports something" check passes over it unchanged. That test's `> 0` bound is
 * satisfied by a bundle carrying one symbol out of ninety. The export list is
 * the only observable that says the entry point is intact, and the source file
 * is the only available statement of what it should be.
 *
 * Under the default `source` target both sides resolve to the same module, so
 * this passes trivially — a green source run is not a bundle check. The run
 * that means something is `test-vitest-dist` (`WORKGLOW_TEST_TARGET=dist`),
 * where the left side is the real bundle; hence a unit-tier file, since that is
 * the tier the dist job runs.
 */
describe("published entry export parity", () => {
  it("enumerates every workspace manifest, so an empty sweep cannot pass", () => {
    // Anti-vacuity: a typo in the walk yields a short list rather than an
    // error, and a short list passes every assertion below.
    expect(pairs.length).toBeGreaterThan(60);
  });

  it("maps every published entry back to a source file", () => {
    // A published entry whose target is not `./dist/<entry>.js`, or whose
    // source twin is missing, is silently dropped from the sweep above — the
    // same hole in a different shape. Listed here so it fails loudly instead.
    expect(unmapped).toEqual([]);
  });

  it("keeps every exemption pinned to an entry that still exists", () => {
    // An exemption that outlives its package silently exempts nothing, and
    // reads as if a real hole were still open.
    const published = new Set(pairs.map((pair) => pair.specifier));
    expect(Object.keys(UNCHECKABLE).filter((specifier) => !published.has(specifier))).toEqual([]);
    for (const reason of Object.values(UNCHECKABLE)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it.each(checkable.map((pair) => [pair.specifier, pair.sourcePath] as const))(
    "%s exports the same names as its source",
    async (specifier, sourcePath) => {
      const [published, source] = await Promise.all([
        import(/* @vite-ignore */ specifier) as Promise<Record<string, unknown>>,
        import(/* @vite-ignore */ sourcePath) as Promise<Record<string, unknown>>,
      ]);
      // Sorted, so the diff on failure names the missing symbols rather than
      // reporting two shuffled lists as unequal.
      expect(Object.keys(published).sort()).toEqual(Object.keys(source).sort());
    }
  );
});
