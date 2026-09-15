/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  formatGaps,
  planTypecheckTests,
  TEST_FILE_SUFFIXES,
  type TestProgram,
  type WorkspaceTests,
} from "./lib/typecheckTests";

function testProject(config: string, testFiles: readonly string[]): TestProgram {
  return { config, kind: "test-project", run: true, testFiles };
}

function buildProject(config: string, testFiles: readonly string[], run = true): TestProgram {
  return { config, kind: "build-project", run, testFiles };
}

describe("planTypecheckTests", () => {
  it("fails a workspace whose tests no program lists at all", () => {
    // The defect this guard replaces: a package with co-located tests and no
    // project file was indistinguishable from a package with no tests, so the
    // glob skipped it and the job passed.
    const workspace: WorkspaceTests = {
      dir: "packages/web-search",
      testFiles: ["packages/web-search/src/__tests__/limitResults.test.ts"],
      programs: [buildProject("packages/web-search/tsconfig.json", [])],
    };
    const plan = planTypecheckTests([workspace]);
    expect(plan.run).toEqual([]);
    expect(plan.covered).toEqual([]);
    expect(plan.gaps).toEqual([
      {
        dir: "packages/web-search",
        reason: "unchecked",
        files: ["packages/web-search/src/__tests__/limitResults.test.ts"],
      },
    ]);
  });

  it("accepts a build program that lists the tests and is run by build-types", () => {
    // `packages/test` and the examples are checked this way. A second program
    // over the same files would pay for the same work twice.
    const plan = planTypecheckTests([
      {
        dir: "examples/cli",
        testFiles: ["examples/cli/src/ui/model/runCensus.test.ts"],
        programs: [
          buildProject("examples/cli/tsconfig.json", [
            "examples/cli/src/ui/model/runCensus.test.ts",
          ]),
        ],
      },
    ]);
    expect(plan.gaps).toEqual([]);
    expect(plan.run).toEqual([]);
    expect(plan.covered).toEqual([
      { dir: "examples/cli", count: 1, configs: ["examples/cli/tsconfig.json"] },
    ]);
  });

  it("refuses a program nothing runs, and says so rather than naming a missing file", () => {
    // Being listed in a program is not being checked by it. A workspace that
    // declares no `build-types` never has its own tsconfig compiled, so the
    // fix is to run that program, not to write a config that already exists.
    const plan = planTypecheckTests([
      {
        dir: "examples/web",
        testFiles: ["examples/web/src/graph/nodeUsage.test.ts"],
        programs: [
          buildProject(
            "examples/web/tsconfig.json",
            ["examples/web/src/graph/nodeUsage.test.ts"],
            false
          ),
        ],
      },
    ]);
    expect(plan.gaps).toEqual([
      {
        dir: "examples/web",
        reason: "unrun",
        files: ["examples/web/src/graph/nodeUsage.test.ts"],
      },
    ]);
  });

  it("checks membership per file, so a project file that misses one still fails", () => {
    // A `tsconfig.test.json` whose `include` names one spelling leaves the
    // other outside the gate exactly the way a missing config does — which is
    // why coverage is asked per file rather than per workspace.
    const plan = planTypecheckTests([
      {
        dir: "packages/mcp",
        testFiles: ["packages/mcp/src/a.test.ts", "packages/mcp/src/b.test.tsx"],
        programs: [
          buildProject("packages/mcp/tsconfig.json", []),
          testProject("packages/mcp/tsconfig.test.json", ["packages/mcp/src/a.test.ts"]),
        ],
      },
    ]);
    expect(plan.run).toEqual(["packages/mcp/tsconfig.test.json"]);
    expect(plan.gaps).toEqual([
      { dir: "packages/mcp", reason: "unchecked", files: ["packages/mcp/src/b.test.tsx"] },
    ]);
  });

  it("runs every test project it finds, including one whose workspace has no tests", () => {
    // A project file left behind by deleted tests still runs: it costs a second
    // and a stale one is worth seeing fail.
    const plan = planTypecheckTests([
      {
        dir: "packages/util",
        testFiles: [],
        programs: [testProject("packages/util/tsconfig.test.json", [])],
      },
    ]);
    expect(plan.run).toEqual(["packages/util/tsconfig.test.json"]);
    expect(plan.gaps).toEqual([]);
    expect(plan.covered).toEqual([]);
  });

  it("takes both test-file spellings", () => {
    // `.test.tsx` was invisible to every walk in the repo while 53 `.tsx`
    // sources sat inside sections that run tests.
    expect(TEST_FILE_SUFFIXES).toEqual([".test.ts", ".test.tsx"]);
  });
});

describe("formatGaps", () => {
  it("names the workspace, the count and the fix", () => {
    const message = formatGaps([
      { dir: "packages/web-search", reason: "unchecked", files: ["a.test.ts", "b.test.ts"] },
    ]);
    expect(message).toContain("packages/web-search: 2 test file(s)");
    expect(message).toContain("add packages/web-search/tsconfig.test.json");
  });

  it("counts what it elides, so the list reads as partial rather than complete", () => {
    const message = formatGaps(
      [
        {
          dir: "examples/cli",
          reason: "unchecked",
          files: ["a.test.ts", "b.test.ts", "c.test.ts"],
        },
      ],
      1
    );
    expect(message).toContain("      a.test.ts\n      … and 2 more");
  });
});
