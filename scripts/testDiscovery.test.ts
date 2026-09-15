/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverTestFiles,
  findAllTestFiles,
  findUnreachable,
  KNOWN_KINDS,
  listDirs,
  listSections,
  listTestProjects,
  matchesKind,
  PACKAGE_GROUPS,
  ROOT,
  SECTION_GROUPS,
  VITEST_MODULE_MOCKING,
} from "./lib/testDiscovery";

/**
 * Guards the runner's file selection.
 *
 * A test file no section+kind selection reaches never runs in CI, because every
 * CI job passes a kind. That is not hypothetical: a hand-maintained section
 * table previously omitted seven directories, and pointed nowhere outside
 * `packages/test`, leaving 28 files that no CI job could select. Discovery makes
 * the omission structurally impossible; these assertions keep it that way.
 */
describe("test discovery", () => {
  const files = discoverTestFiles();

  it("finds test files", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("discovers every test file that exists anywhere in the repo", () => {
    // The load-bearing assertion. Checked against an independent walk of the
    // whole tree, because a discovered file's section is derived from its own
    // directory — so "every file is in a known section" proves nothing on its
    // own. A test placed where discovery does not scan fails here.
    const discovered = new Set(files.map((f) => f.path));
    const orphans = findAllTestFiles()
      .filter((f) => !discovered.has(f))
      .map((f) => f.replace(ROOT + "/", ""));
    expect(orphans).toEqual([]);
  });

  it("reaches every test file by some section+kind selection", () => {
    const unreachable = findUnreachable(files).map((f) => f.path.replace(ROOT + "/", ""));
    expect(unreachable).toEqual([]);
  });

  it("assigns every file exactly one kind", () => {
    const miskinded = files.filter(
      (f) => KNOWN_KINDS.filter((k) => matchesKind(f.path, [k])).length !== 1
    );
    expect(miskinded.map((f) => f.path.replace(ROOT + "/", ""))).toEqual([]);
  });

  it("tags a file only Vitest's runner can run so the Bun selection drops it", () => {
    // `@vitest-environment jsdom` is how a test gets a DOM, and Vitest's module
    // registry (`vi.mock` and friends) has no Bun equivalent. Untagged, such a
    // file fails on the runner — or worse, passes with a mock installed after the
    // module under test already imported the real thing.
    const mistagged = files
      .filter((f) => {
        const source = readFileSync(f.path, "utf8");
        return (
          /^\s*(\/\/|\/\*)\s*@vitest-environment\s/m.test(source) ||
          VITEST_MODULE_MOCKING.test(source)
        );
      })
      .filter((f) => f.runner !== "vitest")
      .map((f) => f.path.replace(ROOT + "/", ""));
    expect(mistagged).toEqual([]);
  });

  it("covers in-package tests, not just the monolithic test package", () => {
    // The previous runner selected zero of these, so they never ran in CI.
    const inPackage = files.filter((f) => !f.path.includes("/packages/test/src/"));
    expect(inPackage.length).toBeGreaterThan(0);
  });

  it("runs every discovered test file under some project root in the real config", async () => {
    // Vitest only runs files beneath a project root. A file outside every root
    // does not fail, does not warn, and does not appear in any count — it simply
    // stops running, which is strictly worse than being unselectable.
    //
    // This reads the ACTUAL vitest.config.ts rather than re-deriving the roots.
    // Comparing `listTestProjects()` against `projectDirOf()` would be vacuous —
    // both walk the same structure, so it could never fail. The failure that can
    // really happen is the config drifting away from discovery, which is only
    // visible from the config itself.
    const mod = await import("../vitest.config.ts");
    // A vitest project may be written as a path glob instead of an inline
    // config; this one derives every project as an object, so the roots are
    // read from that shape rather than handled two ways.
    const projects = (mod.default.test?.projects ?? []) as Array<{ test: { root: string } }>;
    const roots: string[] = projects.map((p) => p.test.root);
    expect(roots.length).toBeGreaterThan(0);
    const uncovered = files
      .filter((f) => !roots.some((r) => f.path === r || f.path.startsWith(r + "/")))
      .map((f) => f.path.replace(ROOT + "/", ""));
    expect(uncovered).toEqual([]);
  });

  it("forwards CLI --typecheck onto the ai project", async () => {
    // Vitest's project `cliOverrides` whitelist omits `typecheck`, so
    // `vitest run --typecheck --typecheck.only <file.test-d.ts>` would collect
    // zero files unless the ai project sets enabled/only from argv. Other
    // projects stay off: tsconfig.typecheck.json only includes packages/ai.
    const mod = await import("../vitest.config");
    expect(mod.typecheckFromArgv(["vitest", "run"])).toEqual({ enabled: false, only: false });
    expect(mod.typecheckFromArgv(["vitest", "run", "--typecheck", "--typecheck.only"])).toEqual({
      enabled: true,
      only: true,
    });
    const expected = mod.typecheckFromArgv(process.argv);
    const projects = (mod.default.test?.projects ?? []) as Array<{
      test: { name: string; typecheck: { enabled: boolean; only: boolean } };
    }>;
    const ai = projects.find((p) => p.test.name === "ai");
    expect(ai).toBeDefined();
    expect(ai!.test.typecheck.enabled).toBe(expected.enabled);
    expect(ai!.test.typecheck.only).toBe(expected.only);
    for (const p of projects) {
      if (p.test.name === "ai") continue;
      expect(p.test.typecheck.enabled).toBe(false);
    }
  });

  it("gives every workspace that holds tests a `test` script for Turbo to run", () => {
    // `turbo run test` invokes each workspace's own `test` script. A workspace
    // with tests but no script is not an error to Turbo — it reports the task
    // successful and runs nothing, so `--changed` would report green while
    // skipping the package entirely.
    const missing = listTestProjects(files)
      .filter((p) => PACKAGE_GROUPS.some((g) => p.dir.startsWith(g + "/")))
      .filter((p) => {
        const pkg = JSON.parse(readFileSync(join(ROOT, p.dir, "package.json"), "utf8"));
        return typeof pkg.scripts?.test !== "string";
      })
      .map((p) => p.dir);
    expect(missing).toEqual([]);
  });

  it("gives no workspace a `test` script it cannot satisfy", () => {
    // The converse of the check above, and the one that actually breaks CI:
    // `bun test` in a workspace with no test files exits 1 ("No tests found"),
    // so a leftover script fails `turbo run test` — i.e. `--changed` — for every
    // change that reaches that package, no matter what the tests say.
    const withTests = new Set(listTestProjects(files).map((p) => p.dir));
    const offenders: string[] = [];
    for (const group of PACKAGE_GROUPS) {
      for (const pkg of listDirs(join(ROOT, group))) {
        const dir = `${group}/${pkg}`;
        if (withTests.has(dir)) continue;
        let pkgJson: { scripts?: Record<string, string> };
        try {
          pkgJson = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
        } catch {
          continue;
        }
        if (typeof pkgJson.scripts?.test === "string") offenders.push(dir);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("maps every grouped directory to a section that still exists", () => {
    // A directory renamed or deleted without updating SECTION_GROUPS leaves a
    // dangling entry — harmless today, misleading later.
    const sections = new Set(listSections(files));
    const dangling = Object.keys(SECTION_GROUPS).filter((s) => !sections.has(s));
    expect(dangling).toEqual([]);
  });
});
