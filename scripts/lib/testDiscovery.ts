/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Test-file discovery shared by the runner (`scripts/test.ts`) and the guard test
 * that asserts every test file is reachable. Both must agree, so neither owns it.
 *
 * Sections are DISCOVERED, never enumerated. A directory that matches no coarse
 * grouping becomes its own section rather than being dropped from filtered runs.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.dir` and `Bun.Glob` are Bun-only; this module is also imported by
// a vitest (Node) test, so everything here stays on portable node: APIs.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** The legacy monolithic test package: sections come from its subdirectories. */
export const TEST_BASE = join(ROOT, "packages/test/src/test");
/** Workspace groups that may hold in-package tests (sectioned by package name). */
export const PACKAGE_GROUPS = ["packages", "providers", "examples"] as const;
/** Non-package directories that also hold tests (e.g. tests for the tooling itself). */
export const EXTRA_TEST_DIRS = ["scripts"] as const;

export const KNOWN_KINDS = ["unit", "integration", "end2end"] as const;
export type Kind = (typeof KNOWN_KINDS)[number];

/**
 * Coarse sections that intentionally group several directories. Anything absent
 * becomes a section named after its own directory, so a new directory is always
 * reachable — the previous hand-maintained table silently dropped seven
 * directories from every filtered run, and therefore from CI.
 */
export const SECTION_GROUPS: Readonly<Record<string, readonly string[]>> = {
  graph: [
    "task-graph",
    "task-graph-cache",
    "task-graph-job-queue",
    "task-graph-output-cache",
    "task-graph-storage",
  ],
  storage: [
    "storage-kv",
    "storage-tabular",
    "storage-util",
    "storage-migrations",
    "storage-text",
    "storage-vector",
    "tabular-migrations",
    "vector",
    "helpers",
  ],
  queue: ["job-queue"],
  util: ["util", "human", "schema"],
  ai: ["ai", "ai-model"],
  provider: ["ai-provider"],
  "provider-hft": ["ai-provider-hft"],
  "provider-nodellama": ["ai-provider-nodellama"],
  "provider-api": ["ai-provider-api"],
  "provider-cactus": ["ai-provider-cactus"],
  browser: ["browser", "browser-control"],
  entitlement: ["entitlement-profile"],
};

export interface TestFile {
  readonly path: string;
  readonly section: string;
  /**
   * `bun` when the file imports `bun:test` — it uses Bun-only APIs
   * (`Bun.spawn`, `import.meta.dir`) and cannot run under vitest, so vitest
   * selection must skip it rather than fail on an unresolvable import.
   *
   * `vitest` when the file needs something only Vitest's runner provides:
   *
   * - `@vitest-environment`, which is how a test gets a DOM. Bun's runner has no
   *   environments, so the file fails on `document is not defined`.
   * - Vitest's module-mocking machinery. `vi.mock` is hoisted above the imports;
   *   Bun's `mock.module` runs where it is written, so the module under test has
   *   already imported the real dependency — the mock quietly does nothing — and
   *   an un-awaited async factory blocks the whole file. `vi.doMock`,
   *   `vi.importActual` and `vi.resetModules` have no Bun equivalent at all.
   */
  readonly runner: "bun" | "vitest" | "any";
}

/**
 * A call to Vitest's module registry, at the start of a line so a mention in
 * prose does not count. Shared with `testDiscovery.test.ts`, which fails if a
 * file matching it is not tagged `vitest`.
 */
export const VITEST_MODULE_MOCKING =
  /^\s*(await\s+)?vi\.(mock|doMock|unmock|doUnmock|importActual|importMock|resetModules)\(/m;

function runnerFor(path: string): "bun" | "vitest" | "any" {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return "any";
  }
  if (/from\s*["']bun:test["']/.test(source)) return "bun";
  if (/^\s*(\/\/|\/\*)\s*@vitest-environment\s/m.test(source)) return "vitest";
  if (VITEST_MODULE_MOCKING.test(source)) return "vitest";
  return "any";
}

function dirToSection(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [section, dirs] of Object.entries(SECTION_GROUPS)) {
    for (const d of dirs) map.set(d, section);
  }
  return map;
}

/**
 * Recursively collect files ending in any of `suffixes` under `base`.
 *
 * Shared with the typecheck gate, which walks for a wider set of suffixes than
 * discovery does: the two ask different questions of the same tree and must not
 * each grow their own walker.
 */
export function walkFiles(base: string, suffixes: readonly string[], out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(base, name);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walkFiles(full, suffixes, out);
    else if (suffixes.some((suffix) => name.endsWith(suffix))) out.push(full);
  }
  return out;
}

/** Immediate subdirectories of `base`; empty when `base` does not exist. */
export function listDirs(base: string): string[] {
  try {
    return readdirSync(base).filter((d) => {
      try {
        return statSync(join(base, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** Every test file in the repo, each tagged with the section it belongs to. */
export function discoverTestFiles(): TestFile[] {
  const out: TestFile[] = [];
  const seen = new Set<string>();
  const sectionOf = dirToSection();

  for (const dir of listDirs(TEST_BASE)) {
    const section = sectionOf.get(dir) ?? dir;
    for (const f of walkFiles(join(TEST_BASE, dir), [".test.ts"])) {
      if (seen.has(f)) continue;
      seen.add(f);
      out.push({ path: f, section, runner: runnerFor(f) });
    }
  }

  // In-package tests. These were invisible to the previous runner entirely:
  // no section pointed outside packages/test, so none of them ever ran in CI.
  for (const group of PACKAGE_GROUPS) {
    for (const pkg of listDirs(join(ROOT, group))) {
      if (group === "packages" && pkg === "test") continue; // handled above
      for (const f of walkFiles(join(ROOT, group, pkg, "src"), [".test.ts"])) {
        if (seen.has(f)) continue;
        seen.add(f);
        out.push({ path: f, section: pkg, runner: runnerFor(f) });
      }
    }
  }

  // Tooling tests (e.g. the runner's own test) live outside any package.
  for (const dir of EXTRA_TEST_DIRS) {
    for (const f of walkFiles(join(ROOT, dir), [".test.ts"])) {
      if (seen.has(f)) continue;
      seen.add(f);
      out.push({ path: f, section: dir, runner: runnerFor(f) });
    }
  }

  return out;
}

/**
 * Every `*.test.ts` anywhere in the repo, found by walking from the root and
 * ignoring how sections are computed.
 *
 * This is the independent oracle `discoverTestFiles()` is checked against: the
 * section of a discovered file is derived from its own directory, so asking
 * "is every discovered file in a known section" is vacuously true. The failure
 * that actually matters is a test file in a location discovery never scans —
 * a new top-level group, or tests outside a package's `src/`.
 */
export function findAllTestFiles(): string[] {
  return walkFiles(ROOT, [".test.ts"]);
}

export function listSections(files: readonly TestFile[]): string[] {
  return [...new Set(files.map((f) => f.section))].sort();
}

/** A vitest project: one workspace (or tooling directory) that holds tests. */
export interface TestProject {
  /** `--project` name — the package's directory name (`task-graph`, `scripts`). */
  readonly name: string;
  /** Project root, relative to the repo root (`packages/task-graph`). */
  readonly dir: string;
}

/**
 * The vitest projects, DERIVED from where tests actually are rather than
 * enumerated. A hand-written project list would drift exactly the way the
 * section table did — silently dropping a directory from every run — and here
 * the consequence is worse: a file under no project root is not merely
 * unselectable, it never runs at all.
 *
 * A file directly under an {@link EXTRA_TEST_DIRS} entry projects to that
 * directory; anything else projects to its workspace (`packages/<pkg>`).
 */
export function listTestProjects(files: readonly TestFile[]): TestProject[] {
  const byDir = new Map<string, string>();
  for (const f of files) {
    const dir = projectDirOf(f.path);
    if (dir !== undefined) byDir.set(dir, dir.split("/").pop() ?? dir);
  }
  const projects = [...byDir.entries()]
    .map(([dir, name]) => ({ name, dir }))
    .sort((a, b) => a.dir.localeCompare(b.dir));

  // The name is the directory's basename, and the same basename can appear in
  // two groups (`packages/foo` and `providers/foo`). Two projects sharing a name
  // make `--project foo` ambiguous and each package's own `test` script point at
  // the wrong tree, so fail loudly here rather than run the wrong suite.
  const byName = new Map<string, string[]>();
  for (const p of projects) byName.set(p.name, [...(byName.get(p.name) ?? []), p.dir]);
  const collisions = [...byName.entries()].filter(([, dirs]) => dirs.length > 1);
  if (collisions.length > 0) {
    throw new Error(
      `Duplicate vitest project name(s): ${collisions
        .map(([name, dirs]) => `${name} (${dirs.join(", ")})`)
        .join("; ")}`
    );
  }
  return projects;
}

/** The project directory a test file belongs to, or `undefined` if none covers it. */
export function projectDirOf(filePath: string): string | undefined {
  const rel = filePath.startsWith(ROOT + "/") ? filePath.slice(ROOT.length + 1) : filePath;
  const parts = rel.split("/");
  if ((EXTRA_TEST_DIRS as readonly string[]).includes(parts[0])) return parts[0];
  if ((PACKAGE_GROUPS as readonly string[]).includes(parts[0]) && parts.length > 1) {
    return `${parts[0]}/${parts[1]}`;
  }
  return undefined;
}

export function matchesKind(filePath: string, kinds: readonly Kind[]): boolean {
  if (kinds.length === 0) return true;
  const base = filePath.split("/").pop() ?? filePath;
  for (const kind of kinds) {
    if (kind === "unit" && !base.includes(".integration.") && !base.includes(".e2e.")) return true;
    if (kind === "integration" && base.includes(".integration.test.ts")) return true;
    if (kind === "end2end" && base.includes(".e2e.test.ts")) return true;
  }
  return false;
}

/** Files no section+kind selection can reach — i.e. files CI would never run. */
export function findUnreachable(files: readonly TestFile[]): TestFile[] {
  const sections = new Set(listSections(files));
  return files.filter(
    (f) => !sections.has(f.section) || !KNOWN_KINDS.some((k) => matchesKind(f.path, [k]))
  );
}
