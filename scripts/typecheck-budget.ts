/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Typecheck budget guard.
 *
 * Catches type-level performance regressions (instantiation explosions) at PR
 * time. It type-checks each composite package in isolation with
 * `tsc --extendedDiagnostics`, reads the deterministic `Instantiations` count,
 * and compares it against committed per-package budgets. Instantiations are
 * machine-independent (unlike wall-clock check time), so the gate is stable
 * across CI runners while still catching the kind of regressions this guard
 * exists for — e.g. a schema `allOf` change that took `tasks` from ~290k to
 * ~6.7M instantiations, or a base-generic change that doubled `ai`.
 *
 * The committed numbers are what **TypeScript 7's** `tsc` counts. They are not
 * comparable to a TypeScript 6 baseline — the same tree measured 19-216% higher
 * on the move to 7 — so a compiler bump means re-baselining with `--update`
 * rather than reading the jump as a regression.
 *
 * A package is over budget only once it exceeds BOTH the relative tolerance
 * and the absolute slack — see {@link TypecheckBudget.slack}.
 *
 * Every package carries an entry, whatever its size: `--update` writes one for
 * each, so a package the budget file does not name means the baseline was never
 * taken and the guard is not watching it. That fails the check rather than
 * printing a line among forty others.
 *
 * Usage:
 *   bun scripts/typecheck-budget.ts            # check against budgets, exit 1 on regression or unrecorded package
 *   bun scripts/typecheck-budget.ts --update   # rewrite budgets from current measurements
 *   bun scripts/typecheck-budget.ts --json     # emit measurements as JSON to stdout
 *   bun scripts/typecheck-budget.ts --no-build # skip the warm `tsc -b` (reuse existing dist .d.ts)
 *   bun scripts/typecheck-budget.ts --tolerance 0.2
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.dir` is Bun-only and this module is also imported by a vitest
// (Node) test, so module scope stays on portable node: APIs. `Bun.Glob` below
// is fine where it is: only `main()` reaches it.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUDGET_FILE = join(ROOT, "scripts", "typecheck-budget.json");
const TSC = join(ROOT, "node_modules", ".bin", "tsc");

/** Per-package budget plus global settings persisted to {@link BUDGET_FILE}. */
export interface TypecheckBudget {
  /** Fractional headroom allowed over budget before failing (e.g. 0.15 = +15%). */
  readonly tolerance: number;
  /**
   * Absolute headroom allowed over budget, applied when it is more generous
   * than {@link tolerance}. A few-hundred-instantiation package moves by well
   * over 15% when one type reference is added, so the percentage alone gates
   * the smallest packages on noise; the large packages this guard exists for
   * are far past this in absolute terms and stay on the percentage.
   */
  readonly slack: number;
  /** Per-package instantiation budgets, keyed by workspace-relative dir. */
  readonly packages: Readonly<Record<string, number>>;
}

export interface PackageMeasurement {
  readonly pkg: string;
  readonly instantiations: number;
  /** Wall-clock check time in seconds — informational only, never gated. */
  readonly checkTimeSeconds: number;
}

const DEFAULT_TOLERANCE = 0.15;
const DEFAULT_SLACK = 2_000;

function listPackageDirs(): string[] {
  const dirs: string[] = [];
  for (const group of ["packages", "providers"]) {
    const groupDir = join(ROOT, group);
    if (!existsSync(groupDir)) continue;
    const glob = new Bun.Glob("*/tsconfig.json");
    for (const match of glob.scanSync({ cwd: groupDir, onlyFiles: true })) {
      dirs.push(`${group}/${match.replace(/\/tsconfig\.json$/, "")}`);
    }
  }
  return dirs.sort();
}

function run(cmd: string, args: string[]): { stdout: string; status: number } {
  const result = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  return { stdout: `${result.stdout ?? ""}${result.stderr ?? ""}`, status: result.status ?? 1 };
}

/** Build every composite package so each one's dependency `.d.ts` exist on disk. */
function warmBuild(dirs: string[]): void {
  for (const dir of dirs) rmSync(join(ROOT, dir, "tsconfig.tsbuildinfo"), { force: true });
  // Emit declarations only; we just need the .d.ts graph, not JS.
  run(TSC, ["-b", ...dirs, "--force"]);
}

function extractNumber(output: string, label: RegExp): number {
  const match = output.match(label);
  return match ? Number(match[1].replace(/,/g, "")) : 0;
}

/** Type-check one package in isolation and read its diagnostics. */
function measurePackage(dir: string): PackageMeasurement {
  // Force a full re-check of just this project (deps already built by warmBuild).
  rmSync(join(ROOT, dir, "tsconfig.tsbuildinfo"), { force: true });
  const { stdout } = run(TSC, ["-p", join(dir, "tsconfig.json"), "--extendedDiagnostics"]);
  return {
    pkg: dir,
    instantiations: extractNumber(stdout, /Instantiations:\s+([\d,]+)/),
    checkTimeSeconds: extractNumber(stdout, /Check time:\s+([\d.]+)s/),
  };
}

function loadBudget(): TypecheckBudget {
  if (!existsSync(BUDGET_FILE)) {
    return {
      tolerance: DEFAULT_TOLERANCE,
      slack: DEFAULT_SLACK,
      packages: {},
    };
  }
  const parsed = JSON.parse(readFileSync(BUDGET_FILE, "utf8")) as Partial<TypecheckBudget>;
  return {
    tolerance: parsed.tolerance ?? DEFAULT_TOLERANCE,
    slack: parsed.slack ?? DEFAULT_SLACK,
    packages: parsed.packages ?? {},
  };
}

function writeBudget(budget: TypecheckBudget): void {
  writeFileSync(BUDGET_FILE, `${JSON.stringify(budget, null, 2)}\n`);
}

export interface BudgetCheckResult {
  readonly regressions: ReadonlyArray<{ pkg: string; budget: number; actual: number }>;
  readonly newPackages: ReadonlyArray<{ pkg: string; actual: number }>;
  readonly improvements: ReadonlyArray<{ pkg: string; budget: number; actual: number }>;
}

export function checkAgainstBudget(
  measurements: ReadonlyArray<PackageMeasurement>,
  budget: TypecheckBudget
): BudgetCheckResult {
  const regressions: Array<{ pkg: string; budget: number; actual: number }> = [];
  const newPackages: Array<{ pkg: string; actual: number }> = [];
  const improvements: Array<{ pkg: string; budget: number; actual: number }> = [];

  for (const m of measurements) {
    const allowed = budget.packages[m.pkg];
    if (allowed === undefined) {
      newPackages.push({ pkg: m.pkg, actual: m.instantiations });
      continue;
    }
    const ceiling = Math.max(Math.round(allowed * (1 + budget.tolerance)), allowed + budget.slack);
    const floorForImprovement = Math.min(
      Math.round(allowed * (1 - budget.tolerance)),
      allowed - budget.slack
    );
    if (m.instantiations > ceiling) {
      regressions.push({ pkg: m.pkg, budget: allowed, actual: m.instantiations });
    } else if (m.instantiations < floorForImprovement) {
      improvements.push({ pkg: m.pkg, budget: allowed, actual: m.instantiations });
    }
  }
  return { regressions, newPackages, improvements };
}

/**
 * What fails the build. An unrecorded package counts: it is measured, printed
 * and then gated by nothing, so leaving it to a line on stderr means the
 * ratchet is never written and the guard silently covers one package less.
 */
export function isBudgetCheckFailure(result: BudgetCheckResult): boolean {
  return result.regressions.length > 0 || result.newPackages.length > 0;
}

function formatPct(actual: number, base: number): string {
  const pct = ((actual - base) / base) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`;
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const update = args.has("--update");
  const emitJson = args.has("--json");
  const skipBuild = args.has("--no-build");
  const existing = loadBudget();
  const tolArgIndex = process.argv.indexOf("--tolerance");
  const tolerance = tolArgIndex >= 0 ? Number(process.argv[tolArgIndex + 1]) : existing.tolerance;

  const dirs = listPackageDirs();
  if (!existsSync(TSC)) {
    console.error(`typecheck-budget: tsc not found at ${TSC}. Run \`bun install\` first.`);
    process.exit(1);
  }

  if (!skipBuild) {
    process.stderr.write(`typecheck-budget: warm build of ${dirs.length} packages...\n`);
    warmBuild(dirs);
  }

  const measurements = dirs.map((dir) => {
    const m = measurePackage(dir);
    process.stderr.write(
      `  ${m.pkg.padEnd(38)} inst=${String(m.instantiations).padStart(9)} check=${m.checkTimeSeconds}s\n`
    );
    return m;
  });

  if (emitJson) {
    console.log(JSON.stringify(measurements, null, 2));
  }

  if (update) {
    const packages: Record<string, number> = {};
    for (const m of measurements.sort((a, b) => a.pkg.localeCompare(b.pkg))) {
      packages[m.pkg] = m.instantiations;
    }
    writeBudget({ tolerance, slack: existing.slack, packages });
    process.stderr.write(`typecheck-budget: wrote ${BUDGET_FILE}\n`);
    return;
  }

  const budget = loadBudget();
  const { regressions, newPackages, improvements } = checkAgainstBudget(measurements, budget);

  for (const i of improvements) {
    process.stderr.write(
      `improved: ${i.pkg} ${i.actual} vs budget ${i.budget} (${formatPct(i.actual, i.budget)}) — consider \`--update\` to ratchet\n`
    );
  }
  if (newPackages.length > 0) {
    process.stderr.write(
      `\ntypecheck-budget: ${newPackages.length} package(s) not in the budget file:\n`
    );
    for (const n of newPackages) {
      process.stderr.write(`  ${n.pkg}: ${n.actual} instantiations, no budget recorded\n`);
    }
    process.stderr.write(
      `\nRecord them with: bun scripts/typecheck-budget.ts --update\n` +
        `Until then these packages are not gated at all.\n`
    );
  }

  if (regressions.length > 0) {
    process.stderr.write(
      `\ntypecheck-budget: ${regressions.length} regression(s) over budget ` +
        `(+${budget.tolerance * 100}% or +${budget.slack} instantiations, whichever is larger):\n`
    );
    for (const r of regressions) {
      process.stderr.write(
        `  ${r.pkg}: ${r.actual} instantiations vs budget ${r.budget} (${formatPct(r.actual, r.budget)})\n`
      );
    }
    process.stderr.write(
      `\nIf this growth is expected, re-baseline with: bun scripts/typecheck-budget.ts --update\n`
    );
  }

  if (isBudgetCheckFailure({ regressions, newPackages, improvements })) {
    process.exit(1);
  }

  process.stderr.write(`\ntypecheck-budget: OK (${measurements.length} packages within budget)\n`);
}

if (import.meta.main) {
  main();
}
