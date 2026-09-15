/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Test runner script. Supports filtering by kind and section.
 *
 * Usage: bun scripts/test.ts [--all] [kinds...] [sections...] [--help]
 *
 * Kinds:    unit, integration, end2end (default: all)
 * Sections: discovered from the tree — see `listSections()`
 *
 * Sections are DISCOVERED, never enumerated by hand. Every directory holding
 * tests maps to a section; a directory that matches no known grouping becomes
 * its own section rather than being silently dropped from every filtered run.
 * `--check-sections` fails if any test file is unreachable by section+kind
 * selection, which is what the CI matrix relies on.
 */

import { relative } from "node:path";
import type { ChangedPackages } from "./lib/changedPackages";
import { filesInChangedPackages, resolveChangedPackageDirs } from "./lib/changedPackages";
import type { Kind } from "./lib/testDiscovery";
import {
  discoverTestFiles,
  findAllTestFiles,
  findUnreachable,
  KNOWN_KINDS,
  listSections,
  matchesKind,
  ROOT,
} from "./lib/testDiscovery";
import type { Shard } from "./lib/testShards";
import { parseShard, shardFiles } from "./lib/testShards";
import { resolveTestTarget } from "./lib/workspaceSource";

const KNOWN_RUNNERS = ["bun", "vitest"] as const;

/** RAG ONNX/HuggingFace integration tests load multiple ONNX pipelines per file;
 * default parallelism makes two files load pipelines concurrently and OOM-kills the
 * GitHub-hosted runner (`bun test --parallel=1` is required even though it doubles
 * wall-clock time — the job timeout-minutes covers the extra runtime). */
function isRagOnnxIntegrationFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.includes("/rag/") && normalized.includes(".integration.");
}

function shouldLimitParallelismForHeavyIntegration(files: string[]): boolean {
  return (
    shouldRunLlamaCppIntegrationFilesSequentially(files) || files.some(isRagOnnxIntegrationFile)
  );
}

/** node-llama-cpp/ipull downloads use shared ./models paths; parallel test files corrupt the same .gguf.ipull partial. */
function isLlamaCppProviderIntegrationFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  return normalized.includes("/ai-provider-nodellama/") && base.includes(".integration.test.ts");
}

function shouldRunLlamaCppIntegrationFilesSequentially(files: string[]): boolean {
  const n = files.filter(isLlamaCppProviderIntegrationFile).length;
  return n > 1;
}

function showHelp(sections: readonly string[]): void {
  console.log(`Usage: bun scripts/test.ts [kinds...] [sections...] [runners...] [options]

Kinds:    ${KNOWN_KINDS.join(", ")} (default: all)
Sections: ${sections.join(", ")}
Runners:  ${KNOWN_RUNNERS.join(", ")} (default: vitest; pass 'bun' to use Bun instead)

Options:
  --all             Run the full suite with no kind/section filter (very slow)
  --changed [base]  Run only packages affected by changes vs base (default origin/main),
                    via Turbo. Alone, delegates to turbo run test. With a kind/section,
                    filters the file list so CI slices still apply.
  --except a,b      Run every section EXCEPT these (the sections that have their own
                    CI job). Complements the positional section list.
  --shard i/N       Run only the i-th of N equal pieces of the selection, so one
                    slice can be spread over N parallel CI jobs. Every piece
                    together is the whole selection, and an empty piece passes.
  --check-sections  Verify every test file is reachable by section+kind selection
  --dry-run         Print runner commands without executing them
  --help            Show this usage message

Examples:
  bun scripts/test.ts --all                 # Run all tests
  bun scripts/test.ts unit                  # Run only unit tests
  bun scripts/test.ts storage unit          # Run only unit tests in storage dirs
  bun scripts/test.ts bun storage unit      # Run storage unit tests under Bun
  bun scripts/test.ts integration --except rag,browser
  bun scripts/test.ts vitest unit --shard 2/4   # one of four parallel unit jobs
  bun scripts/test.ts --changed             # turbo test for packages affected since origin/main
  bun scripts/test.ts --changed unit        # unit tests in those packages (what CI uses)
`);
}

/** Run fast unit files before integration/e2e so ONNX-heavy suites start with a cleaner heap and predictable progress order. */
function orderFilteredTestFiles(files: string[]): string[] {
  if (files.length === 0) return files;
  const isHeavy = (f: string) => f.includes(".integration.") || f.includes(".e2e.");
  const light = files.filter((f) => !isHeavy(f)).sort((a, b) => a.localeCompare(b));
  const heavy = files.filter(isHeavy).sort((a, b) => a.localeCompare(b));
  return [...light, ...heavy];
}

function buildBunTestArgs(files: string[]): string[] {
  const parallelFlag: string =
    files.length > 0 && shouldLimitParallelismForHeavyIntegration(files)
      ? "--parallel=1"
      : "--parallel";
  // Match vitest's testTimeout: Bun's default is 5s per test, which is easy to exceed in HF/Sqlite work
  const timeoutFlag = "--timeout=15000";
  const flags = [timeoutFlag, parallelFlag].filter((flag) => flag.length > 0);
  return files.length > 0 ? ["bun", "test", ...flags, ...files] : ["bun", "test", ...flags];
}

/**
 * Whether the caller asked for coverage at all, before the target is consulted.
 *
 * Opt-in by name rather than "any CI run". Coverage is a whole-suite
 * measurement: the split jobs on a pull request each see one slice, so a
 * per-job number is only meaningful once the fragments are stitched back
 * together, and stitching them is machinery — an artifact per job, a merge job,
 * a cleanup job — paid for on every push. It is collected by the nightly run
 * instead, which executes the suite in one job and needs no stitching.
 *
 * `0` and `false` are honored so a workflow can set the variable once and turn
 * it off per job without deleting it.
 */
function coverageAskedFor(env: Record<string, string | undefined>): boolean {
  const raw = env.WORKGLOW_COVERAGE?.trim() ?? "";
  return raw !== "" && raw !== "0" && raw !== "false";
}

/**
 * Whether this run should collect coverage — see {@link coverageAskedFor} for
 * why it is opt-in by name.
 *
 * A `dist`-targeted run measures the bundles, not the sources the coverage
 * denominator names, so every source file would be reported at 0%. Refuse there
 * rather than emit a report that says nothing — and say so, since the caller
 * asked for coverage by name and a silent drop leaves them reading an empty
 * `coverage/` for the reason.
 */
function coverageRequested(env: Record<string, string | undefined>): boolean {
  if (!coverageAskedFor(env)) return false;
  return resolveTestTarget(env.WORKGLOW_TEST_TARGET) !== "dist";
}

function buildVitestArgs(files: string[]): string[] {
  // When no file filter: run all. Otherwise pass relative paths as name filters.
  const relFiles = files.length > 0 ? files.map((f) => relative(ROOT, f)) : [];
  const args = ["npx", "vitest", "run"];
  if (files.length > 0 && shouldLimitParallelismForHeavyIntegration(files)) {
    // One file at a time avoids OOM-kills when multiple ONNX-heavy suites load
    // pipelines in parallel — applies to both local and CI runners (GitHub-hosted
    // ubuntu-latest has ~7 GB RAM, easily exhausted by 2x ONNX feature-extraction
    // pipelines). The job's timeout-minutes covers the longer serial wall-clock.
    args.push("--no-file-parallelism");
  }
  if (coverageRequested(process.env)) {
    args.push("--coverage");
  } else if (coverageAskedFor(process.env)) {
    console.error(
      'WORKGLOW_COVERAGE is set but WORKGLOW_TEST_TARGET="dist": coverage measures the ' +
        "sources, which a dist run never loads, so every file would report 0%. Running " +
        "without --coverage."
    );
  }
  args.push(...relFiles);
  return args;
}

/**
 * `tier` tells the vitest config how much of the tree the caller has already
 * narrowed for it:
 *
 * - `undefined` — this script is not narrowing anything (the Turbo path passes
 *   no files), so the config keeps its default `unit` gate on. That is what
 *   makes `turbo run test` mean "unit tier".
 * - `"all"` — an explicit file list is coming, so the integration gate must be
 *   off or it would drop files the caller named outright. `.e2e` files stay
 *   excluded, because they cost money and downloads and are never implied.
 * - `"e2e"` — the caller asked for the `end2end` kind by name; nothing is
 *   excluded.
 */
async function spawnRunner(
  args: string[],
  label: string,
  opts: { tier?: "all" | "e2e" } = { tier: "all" }
): Promise<number> {
  // Decrypt the credential store here, in the one process every runner is
  // spawned from, so the child inherits the keys already in its environment.
  // The per-file test preload then finds nothing left to decrypt and derives
  // no key — the difference between eight PBKDF2 derivations once and eight per
  // test file. Vitest does the same in its own global setup, for runs that do
  // not come through this script; `bun test` has no such hook, so for Bun this
  // is the only thing between a 700-file run and 700 decryptions of the same
  // eight secrets.
  //
  // Imported HERE rather than at the top of the file, and this is load-bearing:
  // the chain reaches `packages/storage/src`, whose `@workglow/*` specifiers
  // resolve through each package's `exports` into `dist`. Every other import in
  // this module is `node:` or a sibling script, which is what lets
  // `--check-sections` run on a tree that has never been built — the CI
  // discovery job does exactly that. Spawning a runner already requires `dist`,
  // so the dependency is real only on this path.
  const { hydrateTestCredentials } = await import("./lib/test-credentials");
  await hydrateTestCredentials();
  const proc = Bun.spawn(args, {
    cwd: ROOT,
    stdio: ["inherit", "inherit", "inherit"],
    env: opts.tier ? { ...process.env, WORKGLOW_TEST_TIER: opts.tier } : process.env,
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) console.error(`${label} failed with exit code ${exitCode}`);
  return exitCode;
}

// ── Discover ──────────────────────────────────────────────────────────────────

const allFiles = discoverTestFiles();
const KNOWN_SECTIONS = listSections(allFiles);

// ── Parse args ────────────────────────────────────────────────────────────────

let rawArgs = process.argv.slice(2);

if (rawArgs.includes("--help")) {
  showHelp(KNOWN_SECTIONS);
  process.exit(0);
}

/**
 * Guard: a test file that no section+kind selection reaches never runs in CI,
 * because every CI job passes a kind. Discovery makes this structurally
 * impossible; this check keeps it that way.
 */
if (rawArgs.includes("--check-sections")) {
  const bySection = new Map<string, number>();
  for (const f of allFiles) bySection.set(f.section, (bySection.get(f.section) ?? 0) + 1);
  console.log(`Discovered ${allFiles.length} test file(s) across ${bySection.size} section(s):`);
  for (const s of [...bySection.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(s[1]).padStart(4)}  ${s[0]}`);
  }

  // The load-bearing half. A discovered file's section is derived from its own
  // directory, so "every discovered file has a section" is vacuously true — the
  // failure that can really happen is a test file somewhere discovery never
  // scans. Check against an independent walk of the whole tree.
  const discovered = new Set(allFiles.map((f) => f.path));
  const orphans = findAllTestFiles().filter((f) => !discovered.has(f));
  if (orphans.length > 0) {
    console.error(`\n${orphans.length} test file(s) in locations discovery does not scan:`);
    for (const f of orphans) console.error(`  ${relative(ROOT, f)}`);
    process.exit(1);
  }

  const unreachable = findUnreachable(allFiles);
  if (unreachable.length > 0) {
    console.error(`\n${unreachable.length} test file(s) unreachable by any section+kind:`);
    for (const f of unreachable) console.error(`  ${relative(ROOT, f.path)}`);
    process.exit(1);
  }
  console.log("\nEvery test file is discovered and reachable by section+kind selection.");
  process.exit(0);
}

const runAll = rawArgs.includes("--all");
const dryRun = rawArgs.includes("--dry-run");

/**
 * `--changed [base]` — run only the packages a change can reach.
 *
 * Package selection is delegated to Turbo rather than reimplemented here: it
 * already knows the workspace dependency graph, so `...[base]` means "packages
 * changed since base, plus everything that depends on them" — the transitive
 * half is the part a hand-rolled diff would get wrong.
 *
 * Alone (no kind/section/`--except`/`--all`) this is `turbo run test`, which
 * is the unit tier. With a selector, Turbo only names the packages; the file
 * list is still filtered by kind/section so CI jobs keep their slices.
 *
 * Tooling tests outside any workspace (`scripts/`) are included when the git
 * diff touches `scripts/`. A root lockfile/config change is unfiltered.
 */
const changedIdx = rawArgs.indexOf("--changed");
let changedBase: string | undefined;
if (changedIdx !== -1) {
  const next = rawArgs[changedIdx + 1];
  // Only a token that is not itself a selector can be the base. Otherwise
  // `--changed unit` would silently become `--filter=...[unit]` and fail deep
  // inside Turbo with an unresolvable git ref.
  const isSelector =
    next !== undefined &&
    ((KNOWN_KINDS as readonly string[]).includes(next) ||
      KNOWN_SECTIONS.includes(next) ||
      (KNOWN_RUNNERS as readonly string[]).includes(next));
  const takeBase = next !== undefined && !next.startsWith("-") && !isSelector;
  changedBase = takeBase ? next : "origin/main";
  rawArgs = rawArgs.filter((_, i) => i !== changedIdx && !(takeBase && i === changedIdx + 1));
}

const exceptIdx = rawArgs.indexOf("--except");
const exceptValue = exceptIdx === -1 ? undefined : rawArgs[exceptIdx + 1];
const excludedSections = (exceptValue ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/**
 * `--shard i/N` — run one of N equal pieces of whatever the rest of the
 * selection resolves to, so a slice too big for one CI job becomes N parallel
 * ones. The partition itself is {@link shardFiles}; see that module for why it
 * is dealt from a sorted list rather than sliced.
 */
const shardIdx = rawArgs.indexOf("--shard");
const shardValue = shardIdx === -1 ? undefined : rawArgs[shardIdx + 1];
let shard: Shard | undefined;
if (shardIdx !== -1) {
  const parsed = parseShard(shardValue);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(1);
  }
  shard = parsed.shard;
}

const filteredArgs = rawArgs.filter(
  (a, i) =>
    a !== "--all" &&
    a !== "--dry-run" &&
    a !== "--except" &&
    a !== "--shard" &&
    !(exceptIdx !== -1 && i === exceptIdx + 1) &&
    !(shardIdx !== -1 && i === shardIdx + 1)
);

const unknownExcluded = excludedSections.filter((s) => !KNOWN_SECTIONS.includes(s));
if (exceptIdx !== -1 && (excludedSections.length === 0 || unknownExcluded.length > 0)) {
  console.error(
    excludedSections.length === 0
      ? "--except needs a comma-separated section list"
      : `Unknown section(s) in --except: ${unknownExcluded.join(", ")}`
  );
  console.error(`Valid sections: ${KNOWN_SECTIONS.join(", ")}`);
  process.exit(1);
}

if (
  !runAll &&
  filteredArgs.length === 0 &&
  excludedSections.length === 0 &&
  changedBase === undefined
) {
  showHelp(KNOWN_SECTIONS);
  process.exit(0);
}

// Bun is OFF unless asked for. It is a supported runner that occasionally
// surfaces real runtime differences, but running it alongside vitest by default
// doubles every run to re-verify vitest's own semantics on a second runtime.
// Ask for it explicitly (`bun scripts/test.ts bun unit`) or let the scheduled
// parity workflow do it.
const wantsBun = filteredArgs.includes("bun");
const kinds: Kind[] = [];
const sections: string[] = [];
const unknown: string[] = [];

for (const arg of filteredArgs) {
  if ((KNOWN_KINDS as readonly string[]).includes(arg)) kinds.push(arg as Kind);
  else if (KNOWN_SECTIONS.includes(arg)) sections.push(arg);
  else if ((KNOWN_RUNNERS as readonly string[]).includes(arg)) continue;
  else unknown.push(arg);
}

if (unknown.length > 0) {
  console.error(`Unknown argument(s): ${unknown.join(", ")}`);
  console.error(`Valid kinds:    ${KNOWN_KINDS.join(", ")}`);
  console.error(`Valid sections: ${KNOWN_SECTIONS.join(", ")}`);
  console.error(`Valid runners:  ${KNOWN_RUNNERS.join(", ")}`);
  process.exit(1);
}

if (
  changedBase !== undefined &&
  kinds.length === 0 &&
  sections.length === 0 &&
  excludedSections.length === 0 &&
  !runAll
) {
  const args = ["npx", "turbo", "run", "test", `--filter=...[${changedBase}]`];
  console.log(`\nRunning tests for packages affected since ${changedBase}\n`);
  if (dryRun) {
    console.log(JSON.stringify(args));
    process.exit(0);
  }
  process.exit(await spawnRunner(args, "Turbo test", {}));
}

let changedDirs: ChangedPackages | undefined;
if (changedBase !== undefined) {
  console.log(`\nSelecting packages affected since ${changedBase}\n`);
  changedDirs = await resolveChangedPackageDirs(changedBase);
}

// ── Collect test files (when section or kind filter is given) ──────────────────

// `--shard` has to name the files too: a shard is a subset, and the only way to
// express a subset to either runner is an explicit list.
const needsFileFilter =
  sections.length > 0 ||
  kinds.length > 0 ||
  excludedSections.length > 0 ||
  shard !== undefined ||
  (changedDirs !== undefined && changedDirs !== "all");
let selected = needsFileFilter
  ? allFiles
      .filter((f) => (sections.length === 0 ? true : sections.includes(f.section)))
      .filter((f) => !excludedSections.includes(f.section))
      .filter((f) => matchesKind(f.path, kinds))
      // An explicit list overrides the config's tier gate, which is what keeps
      // `.e2e` files out of every run that did not name the kind — so with no
      // kind given (`--all --shard 1/4`) the exclusion has to be applied here
      // instead, or the shard hands vitest the paid, multi-GB tier by name.
      .filter((f) => kinds.includes("end2end") || !f.path.endsWith(".e2e.test.ts"))
  : [];
if (changedDirs !== undefined && changedDirs !== "all") {
  selected = filesInChangedPackages(needsFileFilter ? selected : allFiles, changedDirs);
}

/**
 * The shard is taken from each runner's OWN list, after the compatibility
 * filters below and never before them. Sharding the combined list would deal a
 * `bun:test` file into a vitest shard, where it is dropped as incompatible —
 * and no other shard would hold it, so the file runs nowhere and every job
 * still passes.
 */
const shardOf = (paths: string[]): string[] =>
  shard === undefined ? paths : shardFiles(paths, shard);

// A `@vitest-environment` file needs a DOM Bun's runner cannot provide; running
// it there fails on the environment rather than on anything under test.
const files: string[] = orderFilteredTestFiles(
  shardOf(selected.filter((f) => f.runner !== "vitest").map((f) => f.path))
);
// A `bun:test` file uses Bun-only APIs and cannot run under vitest; skip it there
// rather than letting vitest fail on an unresolvable `bun:test` import.
const vitestFiles: string[] = orderFilteredTestFiles(
  shardOf(selected.filter((f) => f.runner !== "bun").map((f) => f.path))
);

/**
 * Why this runner has nothing to run, for a selection that was not empty to
 * begin with. An empty SHARD is ordinary and passes — a `--changed` pull request
 * narrows the suite to a handful of files, and the shards past the first then
 * hold none of them — so it has to read as that rather than as the
 * incompatible-files case, which is about the tree and not about this job.
 */
function emptySelectionReason(runner: "Bun" | "vitest"): string {
  if (shard !== undefined) {
    return `Shard ${shard.index}/${shard.count} holds no ${runner} files (${selected.length} file(s) in the selection).`;
  }
  return runner === "Bun"
    ? "No Bun-compatible files in selection (all need a vitest environment)."
    : "No vitest-compatible files in selection (all are bun-only).";
}

if (needsFileFilter && selected.length === 0) {
  const kindLabel = kinds.length > 0 ? kinds.join("+") : "all";
  const sectionLabel = sections.length > 0 ? sections.join("+") : "all";
  console.log(`No test files found for kind=${kindLabel} section=${sectionLabel}`);
  process.exit(0);
}

const kindLabel = kinds.length > 0 ? kinds.join("+") : "all";
const sectionLabel = sections.length > 0 ? sections.join("+") : "all";
const exceptLabel = excludedSections.length > 0 ? ` except [${excludedSections.join("+")}]` : "";
const shardLabel = shard === undefined ? "" : ` shard ${shard.index}/${shard.count}`;
// The count is the list the runner about to be spawned will get, and "all
// files" is reserved for the case where no list is passed at all. Reading the
// length alone said "all files" for a selection that resolved to none — which
// is what an empty shard is, and it is the one case where the runner running
// everything instead would be a real failure.
const runnerFiles = wantsBun ? files : vitestFiles;
const fileCount = needsFileFilter ? `${runnerFiles.length} file(s)` : "all files";
console.log(
  `\nRunning ${kindLabel} tests in sections [${sectionLabel}]${exceptLabel}${shardLabel} — ${fileCount}\n`
);

// `.e2e` files are excluded by the vitest config unless the caller named the
// kind, so asking for `end2end` has to lift that gate or the run resolves to
// zero files and vitest exits non-zero on a healthy tree.
const tier = kinds.includes("end2end") ? "e2e" : "all";

if (dryRun) {
  if (wantsBun && needsFileFilter && files.length === 0) {
    // Same trap as the vitest branch below: an empty list makes `bun test` mean
    // "run everything under the configured root".
    console.log(`# bun: skipped — ${emptySelectionReason("Bun")}`);
  } else if (wantsBun) console.log(JSON.stringify(buildBunTestArgs(files)));
  else if (needsFileFilter && vitestFiles.length === 0) {
    // An empty file list makes `vitest run` mean "run everything", so a
    // selection that filtered down to nothing must print no vitest command
    // rather than one that silently widens to the whole suite.
    console.log(`# vitest: skipped — ${emptySelectionReason("vitest")}`);
  } else {
    console.log(JSON.stringify(buildVitestArgs(vitestFiles)));
  }
  process.exit(0);
}

// ── Execute ───────────────────────────────────────────────────────────────────

if (wantsBun) {
  if (needsFileFilter && files.length === 0) {
    console.log(emptySelectionReason("Bun"));
    process.exit(0);
  }
  process.exit(await spawnRunner(buildBunTestArgs(files), "Bun test", { tier }));
}

if (needsFileFilter && vitestFiles.length === 0) {
  console.log(emptySelectionReason("vitest"));
  process.exit(0);
}
process.exit(await spawnRunner(buildVitestArgs(vitestFiles), "Vitest test", { tier }));
