import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, coverageConfigDefaults, defineConfig } from "vitest/config";
// Extension is required: Vite's native config loader cannot resolve an
// extensionless relative import here.
import { discoverTestFiles, listTestProjects } from "./scripts/lib/testDiscovery.ts";
import {
  coverageIncludeGlobs,
  distBundleGuardPlugin,
  listWorkspacePackages,
  resolveTestTarget,
  workspaceSourcePlugin,
} from "./scripts/lib/workspaceSource.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const abs = (p: string): string => path.join(__dirname, p);

/**
 * Vitest's workspace `cliOverrides` whitelist does not include `typecheck`,
 * so `--typecheck` / `--typecheck.only` never reach `test.projects`. Read the
 * flags from argv and enable typecheck on the `ai` project, or the nightly
 * drift guard (`vitest run --typecheck --typecheck.only <file.test-d.ts>`)
 * collects zero files.
 */
export function typecheckFromArgv(argv: readonly string[]): {
  readonly enabled: boolean;
  readonly only: boolean;
} {
  const only = argv.includes("--typecheck.only");
  const enabled = only || argv.includes("--typecheck") || argv.includes("--typecheck.enabled");
  return { enabled, only };
}

const typecheckCli = typecheckFromArgv(process.argv);

/**
 * The coverage `include`/`exclude` globs below are REPO-ROOT-RELATIVE, and the
 * v8 provider matches them against `relative(coverageRoot, file)` — which is
 * the root of the project being reported on. A `--project` run swaps in that
 * project's own root (`packages/ai`), every pattern then matches nothing, and
 * the report comes back a clean `0/0` instead of an error: exactly the silent
 * "measured nothing" this whole setup exists to remove.
 *
 * Refuse the combination rather than emit that report. `--coverage` alone (what
 * `scripts/test.ts` passes) and `--project` alone (what each package's own
 * `test` script passes) both stay legal.
 */
export function coverageProjectConflict(argv: readonly string[]): string | undefined {
  const off = (flag: string): boolean =>
    argv.includes(`--${flag}=false`) || argv.includes(`--${flag}.enabled=false`);
  const has = (flag: string): boolean =>
    argv.some((arg) => arg === `--${flag}` || arg.startsWith(`--${flag}=`));
  if (!has("coverage") || off("coverage") || !has("project")) return undefined;
  return (
    "Coverage and --project cannot be combined: the coverage include/exclude globs in " +
    "vitest.config.ts are repo-root-relative, and a --project run reports against that " +
    "project's own root, where they match nothing and the report reads 0/0. Run coverage " +
    "over the whole tree (`WORKGLOW_COVERAGE=1 bun scripts/test.ts vitest unit`) instead."
  );
}

const coverageConflict = coverageProjectConflict(process.argv);
if (coverageConflict !== undefined) throw new Error(coverageConflict);

/**
 * Tier gate for callers that do NOT pre-select files — `turbo run test` and a
 * bare `vitest run --project <name>`. Those would otherwise mean "every tier",
 * including the integration suites that want databases and live API keys, which
 * is the wrong default for a per-package script.
 *
 * `scripts/test.ts` sets `all` when it spawns vitest, because it has already
 * applied the requested kind filter and hands over an explicit file list — an
 * exclude here would silently drop files the caller asked for by name. It sets
 * `e2e` only when the caller named the `end2end` kind: e2e files cost money and
 * multi-GB downloads, so they stay excluded from every other tier — including
 * `--all` — but a run that asks for them by name must not resolve to zero files.
 */
const tier = process.env.WORKGLOW_TEST_TIER ?? "unit";
const tierExclude =
  tier === "e2e"
    ? []
    : tier === "all"
      ? ["**/*.e2e.test.ts"]
      : ["**/*.integration.test.ts", "**/*.e2e.test.ts"];

/**
 * Options every project needs. Project roots differ, so anything path-shaped
 * here must be ABSOLUTE — a relative `setupFiles` or `typecheck.tsconfig` would
 * resolve against each project's own root and silently fail to load.
 */
const shared = {
  setupFiles: [abs("vitest.setup.ts")],
  // The nightly type-drift guard runs `.test-d.ts` files through vitest's
  // `--typecheck` engine. Scope the tsc program to the package under test so
  // unrelated source (example UIs needing `jsx`, providers relying on their
  // own ambient `types`/`lib`) is not swept in and reported as drift.
  // `enabled`/`only` come from argv: see {@link typecheckFromArgv}. The
  // tsconfig only includes `packages/ai/src`, so only the `ai` project turns
  // typecheck on — other projects would glob their own `.test-d.ts` files
  // into a program that does not contain them.
  typecheck: {
    enabled: false,
    only: typecheckCli.only,
    tsconfig: abs("tsconfig.typecheck.json"),
  },
  testTimeout: 15000, // 15 second global timeout (WASM Postgres / PGlite init can be slow)
  // Vitest uses hookTimeout for beforeEach/afterAll separately from testTimeout; keep both aligned
  hookTimeout: 15000,
  retry: 1,
  exclude: [...configDefaults.exclude, ...tierExclude],
};

const discovered = discoverTestFiles();

/**
 * Which build of the workspace packages a run exercises.
 *
 * `source` (the default) resolves every `@workglow/*` specifier to the
 * package's `src`, so a cross-package suite runs the same files a co-located
 * `__tests__` does. That is what makes coverage mean anything: with the bundles
 * in play, `packages/test` exercises `packages/ai/dist/node.js` and v8
 * attributes every executed line there, leaving `packages/ai/src/**` reading as
 * untested. It also collapses the two module identities a mixed
 * package/relative import graph otherwise produces.
 *
 * `dist` turns the rewrite off, so `exports` resolution stands and the built
 * bundles are what gets loaded. The nightly Bun run already exercises them —
 * `bun test` resolves `exports` natively — so nothing in CI sets this; it is
 * the local escape hatch for reproducing a bundle-only failure under vitest.
 * Its plugin is a guard rather than nothing at all, because the tree a
 * developer reaches for it on is usually a `use-source` tree, where `dist`
 * re-exports `src` and the target would silently measure nothing.
 */
const target = resolveTestTarget(process.env.WORKGLOW_TEST_TARGET);

/**
 * The workspace scan and the plugin are BOTH hoisted out of the project map
 * below, and shared by every project.
 *
 * The plugin is stateless — every decision lives in `resolveWorkspaceSourceId`,
 * over a package list that cannot differ between projects — so one instance
 * serves all of them. Constructing it inside the map re-read every workspace
 * manifest once per project: 12 projects x 41 manifests today, so ~500 file
 * reads before a single test ran, for an answer identical every time.
 *
 * The package list is also what the coverage `exclude` below subtracts
 * non-publishing workspaces from, so it is read exactly once for both uses.
 */
const workspacePackages = listWorkspacePackages(__dirname);
const projectPlugins = [
  target === "dist"
    ? distBundleGuardPlugin(__dirname, workspacePackages)
    : workspaceSourcePlugin(__dirname, workspacePackages),
];

/**
 * One project per workspace that actually holds tests, derived from the same
 * discovery the runner and the reachability guard use. Deriving rather than
 * enumerating is the point: a hand-written list drifts, and a test file under
 * no project root does not merely become unselectable — it stops running
 * entirely, with nothing in the output to say so. `testDiscovery.test.ts` reads
 * this config back and fails if a discovered file falls outside every root.
 *
 * Each project also excludes the `bun:test` files under its root. Those use
 * Bun-only APIs and cannot run under vitest at all — `scripts/test.test.ts`
 * imports `bun:test` and fails to even load. The runner filters them out of its
 * own selection, but `vitest run --project <name>` bypasses the runner, so the
 * exclusion has to live here too or that command fails on a healthy tree.
 */
const projects = listTestProjects(discovered).map((p) => {
  const root = abs(p.dir);
  const bunOnly = discovered
    .filter((f) => f.runner === "bun" && f.path.startsWith(root + "/"))
    .map((f) => f.path.slice(root.length + 1));
  return {
    // Vitest 5 defaults this to `true`, which folds the root config into every
    // project. Nothing here wants that: `shared` above is the whole of what a
    // project is meant to inherit, spelled out so a reader can see it, and the
    // root block holds only `projects` itself and the coverage settings that
    // are read from the root anyway.
    extends: false,
    // Projects are standalone Vite configs, so a root-level `plugins` entry
    // would never reach them — the resolver has to be attached per project.
    plugins: [...projectPlugins],
    test: {
      ...shared,
      name: p.name,
      root,
      exclude: [...shared.exclude, ...bunOnly],
      typecheck: {
        ...shared.typecheck,
        enabled: typecheckCli.enabled && p.name === "ai",
      },
    },
  };
});

export default defineConfig({
  envDir: __dirname,
  test: {
    // Runs in the main process before any worker is spawned, and a worker
    // inherits `process.env` — which is the whole point: the credential store
    // is decrypted once here instead of once per test file. Absolute, like
    // every other path in this file, since a relative one resolves against
    // each project's own root.
    globalSetup: [abs("vitest.globalSetup.ts")],
    projects,
    coverage: {
      provider: "v8", // or 'istanbul'
      reporter: ["text", "json", "json-summary", "html"],
      // Vitest writes no report at all when a test fails, so without this the
      // nightly job's `if: always()` summary and upload steps have nothing to
      // read on exactly the runs someone wants to look at — and they report
      // "no coverage report was produced" rather than the measurement.
      reportOnFailure: true,
      // The denominator is every package's own `src`, stated explicitly rather
      // than left to vitest's default of "files loaded during the run" — that
      // default omits the modules no test imports at all, which are exactly the
      // ones a coverage report exists to surface.
      include: coverageIncludeGlobs(),
      exclude: [
        // `coverageConfigDefaults`, not `configDefaults`: the latter is
        // vitest's TEST-FILE exclude list, which answers a different question.
        // Empty in vitest 5, which is why the entries below are spelled out
        // rather than assumed.
        ...coverageConfigDefaults.exclude,
        "**/node_modules/**",
        // Built output is never the unit of measure. Nothing should resolve
        // here now that specifiers land on `src`, but a `use-source` stub or a
        // stale bundle in a working tree would otherwise be reported as a
        // source file of its own.
        "**/dist/**",
        // The cross-package suite is the harness, not the subject.
        "packages/test/**",
        // The conformance suites are the harness too. Unlike `packages/test`
        // this one publishes, so the `access: "none"` filter below does not
        // reach it — and a suite scores its own coverage by being run, which
        // says nothing about the interfaces it exercises.
        "packages/test-contract/**",
        // The examples keep their suites in `src/test`, which also holds the
        // odd non-`.test.` helper the filename rules below cannot catch.
        "examples/*/src/test/**",
        // Workspaces that publish nothing (`publishConfig.access: "none"`):
        // today only `examples/web`, a Vite app behind no published entry
        // point, whose UI wiring would move the headline number without saying
        // anything about the libraries. The gate is `access: "none"` and not
        // `private`, which `packages/test`, `providers/aws` and
        // `providers/cloudflare` all are while carrying source that counts.
        ...workspacePackages
          .filter((pkg) => !pkg.publishes)
          .map((pkg) => `${path.relative(__dirname, pkg.dir)}/src/**`),
        // Tests, fixtures and typing-only files: counting them inflates every
        // package by the coverage of code that exists to be run.
        //
        // `**/testing/**` is deliberately NOT here. Those directories are
        // published API — `@workglow/task-graph/test` and `@workglow/util/test`
        // ship the repository contracts and the shared fake tasks other
        // packages' suites import by specifier.
        "**/__tests__/**",
        "**/*.test.*",
        "**/*.test-d.ts",
        "**/*.d.ts",
        "**/bench/**",
      ],
    },
  },
});
