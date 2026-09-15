/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Decides which typecheck programs the test gate must run, and which co-located
 * test files no program checks at all.
 *
 * A glob over `packages/*\/tsconfig.test.json` cannot tell "this workspace has
 * no tests" from "this workspace's tests are checked by nothing" — both are a
 * missing file — so a new package joins the tree outside the gate and the gate
 * reports success. The set is derived here instead, from what each program's
 * resolved file list actually contains: a test file in no program that anything
 * runs is named, with its workspace, rather than skipped.
 *
 * Membership is per FILE, not per workspace, because a project file that exists
 * is not the same as a project file that covers the tests — an `include` that
 * lists one suffix leaves the other spelling outside the same way a missing
 * config leaves the whole workspace outside.
 */

/** Test-file spellings the gate walks for. */
export const TEST_FILE_SUFFIXES = [".test.ts", ".test.tsx"] as const;

/** The per-workspace project file that exists to check co-located tests. */
export const TEST_CONFIG_NAME = "tsconfig.test.json";

/** A tsc program found in a workspace, with the test files it resolves. */
export interface TestProgram {
  /** Repo-relative config path, e.g. `packages/web-search/tsconfig.test.json`. */
  readonly config: string;
  /**
   * `test-project` is a {@link TEST_CONFIG_NAME}, which this gate runs itself.
   * `build-project` is the workspace's own `tsconfig.json`, which this gate does
   * not run — `build-types` does, and only where the workspace declares it.
   */
  readonly kind: "test-project" | "build-project";
  /**
   * Whether anything runs this program. A program nothing runs covers nothing,
   * which is the difference between a test file being checked and a test file
   * merely being listed somewhere.
   */
  readonly run: boolean;
  /** Repo-relative test files in the program's resolved file list. */
  readonly testFiles: readonly string[];
}

/** One workspace (or tooling directory) that holds co-located test files. */
export interface WorkspaceTests {
  /** Repo-relative directory, e.g. `packages/web-search`. */
  readonly dir: string;
  /** Every co-located test file under it, repo-relative. */
  readonly testFiles: readonly string[];
  readonly programs: readonly TestProgram[];
}

export interface CoverageGap {
  readonly dir: string;
  /**
   * `unchecked` — no program in the workspace lists the files at all, which is
   * what a missing {@link TEST_CONFIG_NAME} looks like.
   *
   * `unrun` — a program lists them, but nothing runs that program, so the
   * listing buys nothing.
   */
  readonly reason: "unchecked" | "unrun";
  readonly files: readonly string[];
}

/** A workspace whose test files are all covered, and by what. */
export interface CoveredWorkspace {
  readonly dir: string;
  readonly count: number;
  /** Configs covering at least one of its test files, in workspace order. */
  readonly configs: readonly string[];
}

export interface TypecheckTestsPlan {
  /** Test projects to typecheck, in the order the workspaces were walked. */
  readonly run: readonly string[];
  /** Workspaces holding test files no program that runs covers. */
  readonly gaps: readonly CoverageGap[];
  readonly covered: readonly CoveredWorkspace[];
}

export function planTypecheckTests(workspaces: readonly WorkspaceTests[]): TypecheckTestsPlan {
  const run: string[] = [];
  const gaps: CoverageGap[] = [];
  const covered: CoveredWorkspace[] = [];

  for (const ws of workspaces) {
    for (const program of ws.programs) {
      if (program.kind === "test-project") run.push(program.config);
    }
    if (ws.testFiles.length === 0) continue;

    const running = ws.programs.filter((p) => p.run);
    const checked = new Set(running.flatMap((p) => p.testFiles));
    const listed = new Set(ws.programs.flatMap((p) => p.testFiles));
    const uncovered = ws.testFiles.filter((f) => !checked.has(f));

    if (uncovered.length > 0) {
      // Every uncovered file is listed somewhere, or the workspace has nothing
      // checking them at all. Reporting the second as the first would point the
      // reader at a config that does not exist.
      const reason = uncovered.every((f) => listed.has(f)) ? "unrun" : "unchecked";
      gaps.push({ dir: ws.dir, reason, files: uncovered });
      continue;
    }
    covered.push({
      dir: ws.dir,
      count: ws.testFiles.length,
      configs: running.filter((p) => p.testFiles.length > 0).map((p) => p.config),
    });
  }

  return { run, gaps, covered };
}

/** At most `limit` paths, with a count of what was elided. */
function samplePaths(paths: readonly string[], limit: number): string {
  const shown = paths.slice(0, limit).map((p) => `      ${p}`);
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join("\n")}\n      … and ${rest} more` : shown.join("\n");
}

/**
 * The refusal, naming every workspace and how many of its test files are
 * outside the gate — a count so the number can only go down, and the workspace
 * so the fix is obvious from the failure alone.
 */
export function formatGaps(gaps: readonly CoverageGap[], sample = 3): string {
  const lines: string[] = [];
  for (const gap of gaps) {
    const reason =
      gap.reason === "unchecked"
        ? `no typecheck program covers them — add ${gap.dir}/${TEST_CONFIG_NAME}`
        : `the only program listing them is run by nothing`;
    lines.push(`  ${gap.dir}: ${gap.files.length} test file(s) typechecked by nothing`);
    lines.push(`    ${reason}`);
    lines.push(samplePaths(gap.files, sample));
  }
  return lines.join("\n");
}
