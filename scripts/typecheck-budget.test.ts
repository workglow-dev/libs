/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkAgainstBudget,
  isBudgetCheckFailure,
  type PackageMeasurement,
  type TypecheckBudget,
} from "./typecheck-budget";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BUDGET: TypecheckBudget = {
  tolerance: 0.15,
  slack: 2_000,
  packages: { "providers/tiny": 225, "packages/big": 1_000_000 },
};

function measured(pkg: string, instantiations: number): PackageMeasurement {
  return { pkg, instantiations, checkTimeSeconds: 0.1 };
}

describe("checkAgainstBudget", () => {
  // The case this slack exists for: a 225-instantiation package picking up 74
  // more reads as +33% and used to fail the gate, while saying nothing about
  // the instantiation explosions the guard is built to catch.
  it("does not gate a small package on growth within the absolute slack", () => {
    const { regressions } = checkAgainstBudget([measured("providers/tiny", 299)], BUDGET);
    expect(regressions).toEqual([]);
  });

  it("still gates a small package once growth passes the slack", () => {
    const { regressions } = checkAgainstBudget([measured("providers/tiny", 2_300)], BUDGET);
    expect(regressions).toEqual([{ pkg: "providers/tiny", budget: 225, actual: 2_300 }]);
  });

  it("keeps a large package on the relative tolerance, not the slack", () => {
    // +10k instantiations is five times the slack but only +1%, which is the
    // ordinary drift a big package sees; +20% is the regression.
    expect(checkAgainstBudget([measured("packages/big", 1_010_000)], BUDGET).regressions).toEqual(
      []
    );
    expect(
      checkAgainstBudget([measured("packages/big", 1_200_000)], BUDGET).regressions
    ).toHaveLength(1);
  });

  it("applies the same slack to improvements so small packages stay quiet", () => {
    expect(checkAgainstBudget([measured("providers/tiny", 150)], BUDGET).improvements).toEqual([]);
    expect(
      checkAgainstBudget([measured("packages/big", 700_000)], BUDGET).improvements
    ).toHaveLength(1);
  });

  // `--update` records every package whatever its size, so a missing entry
  // means the baseline was skipped and that package is not gated at all —
  // reported at any size, and `main` exits non-zero on it. A size threshold
  // here is how `providers/typesafeai` sat unrecorded and ungated: at 45k it
  // was under the old 50k floor, so the check said nothing and passed.
  it("reports an unbudgeted package whatever its size", () => {
    expect(checkAgainstBudget([measured("packages/new", 12_226)], BUDGET).newPackages).toEqual([
      { pkg: "packages/new", actual: 12_226 },
    ]);
    expect(checkAgainstBudget([measured("packages/new", 60_000)], BUDGET).newPackages).toEqual([
      { pkg: "packages/new", actual: 60_000 },
    ]);
  });

  it("says nothing new about a package the budget already names", () => {
    expect(checkAgainstBudget([measured("providers/tiny", 225)], BUDGET).newPackages).toEqual([]);
  });
});

describe("isBudgetCheckFailure", () => {
  it("fails on a regression", () => {
    expect(
      isBudgetCheckFailure(checkAgainstBudget([measured("packages/big", 1_500_000)], BUDGET))
    ).toBe(true);
  });

  // The whole point of reporting an unrecorded package: nothing else makes
  // anyone write the entry, and until it is written that package is ungated.
  it("fails on a package with no budget entry", () => {
    expect(
      isBudgetCheckFailure(checkAgainstBudget([measured("packages/new", 60_000)], BUDGET))
    ).toBe(true);
  });

  it("passes a measurement set that is merely improved", () => {
    expect(
      isBudgetCheckFailure(checkAgainstBudget([measured("packages/big", 700_000)], BUDGET))
    ).toBe(false);
  });
});

/**
 * The committed file is what the gate compares against, so a package missing
 * from it is a package nobody is measuring. Checking it here means the omission
 * surfaces in the unit suite rather than only in the ~10-minute CI job.
 */
describe("the committed budget file", () => {
  it("records every composite package", () => {
    const budget = JSON.parse(
      readFileSync(join(ROOT, "scripts", "typecheck-budget.json"), "utf8")
    ) as TypecheckBudget;
    const dirs: string[] = [];
    for (const group of ["packages", "providers"]) {
      const groupDir = join(ROOT, group);
      if (!existsSync(groupDir)) continue;
      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (existsSync(join(groupDir, entry.name, "tsconfig.json"))) {
          dirs.push(`${group}/${entry.name}`);
        }
      }
    }
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs.filter((dir) => budget.packages[dir] === undefined)).toEqual([]);
  });
});
