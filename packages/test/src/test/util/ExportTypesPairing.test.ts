/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every condition branch in an `exports` map that declares `types` must point at
 * the declaration file belonging to the implementation named *in that same
 * branch*. A branch whose `types` names a different target hands TypeScript the
 * wrong module: browser consumers of `@workglow/openai/ai` were type-checked
 * against the node build, which exports `_testOnly`,
 * `registerOpenAiImageValidator` and `OpenAI_ModelSearch_Stream` — symbols the
 * browser bundle genuinely does not export.
 */

/** Keys whose value is the module a runtime loads, in resolution order. */
const IMPLEMENTATION_KEYS = ["import", "require", "default"] as const;

/**
 * Branches allowed to pair a `types` target with a differently-named
 * implementation. Each entry must say why the declaration genuinely describes
 * the other file. Empty on purpose: do not add an entry to silence drift — fix
 * the manifest, or emit the missing declaration.
 */
const ALLOWED_MISMATCHES: ReadonlySet<string> = new Set<string>([]);

interface Branch {
  readonly manifest: string;
  readonly subpath: string;
  readonly condition: string;
  readonly types: string;
  readonly implementation: string;
  readonly expectedTypes: string;
}

function declarationFor(implementation: string): string {
  return implementation.replace(/\.[cm]?js$/, ".d.ts");
}

function collectBranches(
  manifest: string,
  subpath: string,
  conditionPath: readonly string[],
  node: unknown,
  out: Branch[]
): void {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return;
  const entry = node as Record<string, unknown>;
  const types = entry.types;
  if (typeof types === "string") {
    const implementation = IMPLEMENTATION_KEYS.map((key) => entry[key]).find(
      (value): value is string => typeof value === "string"
    );
    if (implementation !== undefined) {
      out.push({
        manifest,
        subpath,
        condition: conditionPath.join(" > ") || "(default)",
        types,
        implementation,
        expectedTypes: declarationFor(implementation),
      });
    }
  }
  for (const [key, value] of Object.entries(entry)) {
    if (key === "types" || (IMPLEMENTATION_KEYS as readonly string[]).includes(key)) continue;
    collectBranches(manifest, subpath, [...conditionPath, key], value, out);
  }
}

function repoRoot(): string {
  // Walk up from this file until the workspace root manifest is found.
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { workspaces?: unknown };
      if (pkg.workspaces !== undefined) return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate the workspace root from " + import.meta.url);
}

/** Every workspace manifest, as a repo-root-relative path. */
function workspaceManifests(root: string): string[] {
  const manifests: string[] = [];
  for (const group of ["packages", "providers", "examples"]) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(groupDir, entry.name, "package.json"))) {
        manifests.push(`${group}/${entry.name}/package.json`);
      }
    }
  }
  return manifests.sort();
}

function allBranches(): Branch[] {
  const root = repoRoot();
  const branches: Branch[] = [];
  for (const relative of workspaceManifests(root)) {
    const pkg = JSON.parse(readFileSync(join(root, relative), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    if (!pkg.exports) continue;
    for (const [subpath, value] of Object.entries(pkg.exports)) {
      collectBranches(relative, subpath, [], value, branches);
    }
  }
  return branches;
}

function label(branch: Branch): string {
  return `${branch.manifest} exports["${branch.subpath}"] [${branch.condition}]`;
}

describe("workspace exports maps", () => {
  const branches = allBranches();

  it("finds condition branches to check", () => {
    // Guards against the scan silently finding nothing and the suite passing vacuously.
    expect(branches.length).toBeGreaterThan(50);
  });

  it("pairs every `types` target with the implementation beside it", () => {
    const mismatched = branches
      .filter((branch) => branch.types !== branch.expectedTypes)
      .filter((branch) => !ALLOWED_MISMATCHES.has(label(branch)))
      .map(
        (branch) =>
          `${label(branch)}: types="${branch.types}" but implementation is ` +
          `"${branch.implementation}" (expected types="${branch.expectedTypes}")`
      );
    expect(mismatched).toEqual([]);
  });

  it("keeps the allowlist free of entries that no longer mismatch", () => {
    const stale = [...ALLOWED_MISMATCHES].filter(
      (entry) =>
        !branches.some((branch) => label(branch) === entry && branch.types !== branch.expectedTypes)
    );
    expect(stale).toEqual([]);
  });
});
