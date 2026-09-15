#!/usr/bin/env bun
/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Typechecks every co-located test file in the repo, and refuses to pass when
 * one is checked by nothing.
 *
 * This replaces `for f in packages/*\/tsconfig.test.json`, which could only run
 * the project files that happened to exist. A workspace with tests and no
 * project file looked exactly like a workspace with no tests, so the loop
 * skipped it and reported success — which is how a new package shipped sixteen
 * test files outside every gate, none of them checked by `build` (tests are
 * excluded from the build program), by the suites (vitest transpiles without
 * typechecking) or by the linter (oxlint reports rules, not TS diagnostics).
 *
 * So the set is DERIVED rather than globbed. Each workspace's test files are
 * found by walking its `src`, and each tsc program's coverage is read from
 * `tsc --showConfig`, which expands `include`/`exclude` the way the compiler
 * does instead of re-implementing them. A test file in no program that anything
 * runs fails the job, named, with a count per workspace.
 *
 * Two shapes satisfy the rule, and the difference is which gate runs the
 * program, not which file it is written in:
 *
 * - `tsconfig.test.json` — this script runs it. This is what a package whose
 *   build program excludes tests (every `packages/*` and `providers/*` one
 *   does, so the excluded files never reach `dist`) has to carry.
 * - the workspace's own `tsconfig.json`, where it includes the tests AND the
 *   workspace declares `build-types`, which is what runs that program. The
 *   examples and `packages/test` are checked this way; a second program over
 *   the same files would pay for the same work twice.
 *
 * The walk takes `.test.tsx` as well as `.test.ts`, so a React test cannot
 * arrive outside the gate the way the last new package did.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { EXTRA_TEST_DIRS, listDirs, PACKAGE_GROUPS, ROOT, walkFiles } from "./lib/testDiscovery";
import {
  formatGaps,
  planTypecheckTests,
  TEST_CONFIG_NAME,
  TEST_FILE_SUFFIXES,
  type TestProgram,
  type WorkspaceTests,
} from "./lib/typecheckTests";

const TSC = join(ROOT, "node_modules", ".bin", "tsc");

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

/** Repo-relative, POSIX-separated, so paths compare and print the same way. */
function repoRelative(absolute: string): string {
  return relative(ROOT, absolute).split("\\").join("/");
}

function isTestFile(path: string): boolean {
  return TEST_FILE_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/**
 * The test files one tsc program resolves, read from the compiler itself.
 *
 * `--showConfig` expands `include`/`exclude`/`files` into the program's final
 * file list without typechecking anything, so the answer is the compiler's
 * rather than a second reading of the same globs — a guard that re-implemented
 * them could agree with itself while disagreeing with `tsc`.
 */
function programTestFiles(config: string): readonly string[] {
  const shown = spawnSync(TSC, ["--showConfig", "-p", config], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (shown.status !== 0) {
    fail(`\`tsc --showConfig -p ${config}\` failed:\n${shown.stderr || shown.stdout}`);
  }
  let parsed: { files?: string[] };
  try {
    parsed = JSON.parse(shown.stdout) as { files?: string[] };
  } catch {
    fail(`\`tsc --showConfig -p ${config}\` returned output that is not JSON.`);
  }
  const dir = config.slice(0, config.lastIndexOf("/"));
  return (parsed.files ?? [])
    .map((f) => repoRelative(join(ROOT, dir, f)))
    .filter((f) => isTestFile(f));
}

function programsFor(dir: string, buildProjectIsRun: boolean): TestProgram[] {
  const programs: TestProgram[] = [];
  const build = `${dir}/tsconfig.json`;
  if (existsSync(join(ROOT, build))) {
    programs.push({
      config: build,
      kind: "build-project",
      run: buildProjectIsRun,
      testFiles: programTestFiles(build),
    });
  }
  const test = `${dir}/${TEST_CONFIG_NAME}`;
  if (existsSync(join(ROOT, test))) {
    programs.push({
      config: test,
      kind: "test-project",
      run: true,
      testFiles: programTestFiles(test),
    });
  }
  return programs;
}

/** Whether `build-types` runs this workspace's own `tsconfig.json`. */
function declaresBuildTypes(dir: string): boolean {
  const manifest = join(ROOT, dir, "package.json");
  if (!existsSync(manifest)) return false;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      scripts?: Record<string, string>;
    };
    return parsed.scripts?.["build-types"] !== undefined;
  } catch {
    return false;
  }
}

function collectWorkspaces(): WorkspaceTests[] {
  const workspaces: WorkspaceTests[] = [];

  for (const group of PACKAGE_GROUPS) {
    for (const pkg of listDirs(join(ROOT, group))) {
      const dir = `${group}/${pkg}`;
      const testFiles = walkFiles(join(ROOT, dir, "src"), TEST_FILE_SUFFIXES).map(repoRelative);
      const hasTestConfig = existsSync(join(ROOT, dir, TEST_CONFIG_NAME));
      if (testFiles.length === 0 && !hasTestConfig) continue;
      workspaces.push({
        dir,
        testFiles: testFiles.sort(),
        programs: programsFor(dir, declaresBuildTypes(dir)),
      });
    }
  }

  // Tooling tests live outside every workspace, so nothing builds them and only
  // a test project can cover them.
  for (const dir of EXTRA_TEST_DIRS) {
    const testFiles = walkFiles(join(ROOT, dir), TEST_FILE_SUFFIXES).map(repoRelative);
    const hasTestConfig = existsSync(join(ROOT, dir, TEST_CONFIG_NAME));
    if (testFiles.length === 0 && !hasTestConfig) continue;
    workspaces.push({
      dir,
      testFiles: testFiles.sort(),
      programs: programsFor(dir, false),
    });
  }

  // Directory order comes from `readdir`, which is not stable across machines;
  // a CI log worth diffing against another run needs one order.
  return workspaces.sort((a, b) => a.dir.localeCompare(b.dir));
}

function main(): void {
  if (!existsSync(TSC)) fail(`tsc not found at ${TSC}. Run \`bun install\` first.`);

  const plan = planTypecheckTests(collectWorkspaces());

  for (const c of plan.covered) {
    console.log(
      `  ${c.dir.padEnd(34)} ${String(c.count).padStart(3)} test file(s) ← ${c.configs.join(", ")}`
    );
  }

  if (plan.gaps.length > 0) {
    const total = plan.gaps.reduce((sum, g) => sum + g.files.length, 0);
    fail(
      `${total} co-located test file(s) in ${plan.gaps.length} workspace(s) are typechecked ` +
        `by nothing:\n\n${formatGaps(plan.gaps)}\n\n` +
        `  Tests are excluded from each package's build program, vitest transpiles\n` +
        `  without typechecking and oxlint reports rules rather than TS diagnostics,\n` +
        `  so a type error in these files is invisible until someone reads it.\n` +
        `  ${TEST_CONFIG_NAME} is the program that checks them — copy one from a\n` +
        `  package that has it, e.g. packages/mcp/${TEST_CONFIG_NAME}.`
    );
  }

  const failed: string[] = [];
  for (const config of plan.run) {
    const started = Date.now();
    const result = spawnSync(TSC, ["-p", config], { cwd: ROOT, stdio: "inherit" });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const ok = result.status === 0;
    console.log(`${ok ? "✔" : "✖"} typecheck ${config} (${seconds}s)`);
    if (!ok) failed.push(config);
  }

  // Every project runs before the verdict: stopping at the first failure hides
  // how much is broken, and the second error costs another full CI round trip.
  if (failed.length > 0) fail(`typecheck failed for:\n${failed.map((f) => `    ${f}`).join("\n")}`);

  console.log(
    `\n✔ ${plan.run.length} test project(s) typechecked; ` +
      `${plan.covered.length} workspace(s) with co-located tests, all covered.`
  );
}

main();
