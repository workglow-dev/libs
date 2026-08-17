<!--
  @license
  Copyright 2025 Steven Roussey <sroussey@gmail.com>
  SPDX-License-Identifier: Apache-2.0
-->

# Build System

## Overview

Workglow uses **Turborepo** to orchestrate builds across a **Bun workspaces** monorepo. Each
package compiles its TypeScript source into multiple JavaScript targets (browser, Node.js, and —
where Bun genuinely needs different code — Bun) using `bun build`, and generates type declarations
using `tsc` — TypeScript 7 is itself the native compiler, so there is no separate
`tsgo` binary any more.
Turbo manages the dependency graph between packages so that upstream packages are always built
before their dependents, and its caching layer avoids redundant rebuilds when source files have
not changed.

The build system is designed around three principles:

1. **Per-target compilation** — each runtime gets a dedicated JavaScript bundle built with the
   matching `bun build --target` flag, ensuring platform-specific code paths and polyfills are
   resolved at compile time rather than runtime.
2. **Parallel execution** — within each package, the three (or more) target builds and type
   generation run concurrently via `concurrently`. Across packages, Turbo parallelizes independent
   packages automatically.
3. **Incremental type checking** — TypeScript uses `composite` projects with `incremental` builds
   and `.tsbuildinfo` files, so only changed files are re-checked on subsequent builds.

Key configuration files:

| File | Purpose |
|------|---------|
| `turbo.json` | Turborepo task definitions, dependency ordering, output declarations |
| `package.json` (root) | Workspace definitions, top-level build/test/watch scripts |
| `packages/*/package.json` | Per-package build scripts and conditional exports |
| `tsconfig.json` (root) | Base TypeScript configuration inherited by all packages |
| `packages/*/tsconfig.json` | Per-package TypeScript configuration with entry point lists |

---

## Turborepo Configuration

The `turbo.json` file at the repository root defines the task graph that Turbo uses to determine
build order and caching behavior.

### Task Definitions

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build-clean": {
      "cache": false
    },
    "build-package": {
      "dependsOn": ["build-clean", "^build-package"],
      "outputs": [
        "dist/**/*.js",
        "dist/**/*.js.map",
        "dist/**/*.d.ts",
        "tsconfig.tsbuildinfo"
      ]
    },
    "build-js": {
      "dependsOn": ["build-clean", "^build-js"],
      "outputs": [
        "dist/**/*.js",
        "dist/**/*.js.map"
      ]
    },
    "build-types": {
      "dependsOn": ["build-clean", "^build-types"],
      "outputs": [
        "dist/**/*.d.ts",
        "tsconfig.tsbuildinfo"
      ]
    },
    "build-example": {
      "dependsOn": ["build-clean", "build-package", "^build-package", "^build-example"],
      "outputs": [
        "dist/**/*.js",
        "dist/**/*.js.map"
      ]
    },
    "dev": {
      "persistent": true,
      "cache": false
    },
    "watch": {
      "persistent": true,
      "cache": false
    },
    "watch-js": {
      "persistent": true,
      "cache": false
    },
    "watch-types": {
      "persistent": true,
      "cache": false
    }
  }
}
```

### Task Dependency Graph

Turbo uses two dependency operators:

- **`dependsOn: ["task"]`** — the task in the same package must complete first.
- **`dependsOn: ["^task"]`** — the same-named task in all **upstream** (dependency) packages must
  complete first.

For `build-package`, the combination `["build-clean", "^build-package"]` means:

1. Run `build-clean` in the current package first (removes stale `dist/` and `.tsbuildinfo`).
2. Wait for `build-package` to complete in all packages that the current package depends on
   (following the dependency graph in `package.json`).
3. Then run the current package's `build-package` script.

This ensures that when `@workglow/task-graph` builds, its dependencies (`@workglow/util`,
`@workglow/storage`, `@workglow/job-queue`) are already compiled and their type declarations
are available for import resolution.

The `build-example` task has an additional same-package dependency on `build-package`, ensuring
that the library packages are fully built before any example that lives in the same workspace
attempts to compile.

### Caching and Outputs

Turbo caches task results based on input file hashes and the declared `outputs`. When the inputs
to a task have not changed since the last run, Turbo replays the cached outputs instead of
re-executing the build. The `outputs` array tells Turbo which files to save and restore:

- `dist/**/*.js` and `dist/**/*.js.map` — compiled JavaScript and source maps
- `dist/**/*.d.ts` — TypeScript declaration files
- `tsconfig.tsbuildinfo` — TypeScript incremental build info

The `build-clean` and `watch*` tasks set `"cache": false` because clean operations should always
run, and watch tasks are persistent processes that do not produce cacheable output.

---

## Build Tasks

### `build-package` — Full Package Build

The primary build task. Each package defines this in its `package.json` scripts. For most packages,
it runs JS compilation and type generation in sequence or in parallel:

**Standard package (`@workglow/task-graph`):**

```json
{
  "build-package": "concurrently -c 'auto' -n 'browser,node,types' 'bun run build-browser' 'bun run build-node' 'bun run build-types'"
}
```

All three sub-tasks (two JS targets + types) run concurrently within the package.

**Complex package (`@workglow/util`):**

```json
{
  "build-package": "bun run build-js && bun run build-types"
}
```

Here, `build-js` itself expands into many concurrent builds (browser, node, bun, worker, schema,
graph, media, compress), and `build-types` runs after all JS builds complete. The sequential
ordering (`&&`) ensures that type generation can reference the built artifacts.

**Vendor provider packages (`providers/*`):**

```json
{
  "build-package": "concurrently -c 'auto' -n 'code,types' 'bun run build-code' 'bun run build-types'"
}
```

Each vendor package (`@workglow/anthropic`, `@workglow/openai`, `@workglow/google-gemini`, ...)
ships two entry points — `./ai` (main thread) and `./ai-runtime` (worker /
inline runtime) — built with `--root ./src` to preserve directory structure. Browser-capable
providers (ollama, openai) add `*.browser.ts` variants with `--target=browser`.

### `build-js` — JavaScript Only

Compiles JavaScript without generating type declarations. Useful for rapid iteration when you
only need the runtime artifacts. Turbo runs this across the dependency graph:

```bash
bun run build:js   # Root script: turbo run build-js
```

The per-package `build-js` scripts mirror `build-package` but omit the `build-types` step.

### `build-types` — Type Declarations Only

Generates `.d.ts` files without recompiling JavaScript. Each package runs:

```json
{
  "build-types": "rm -f tsconfig.tsbuildinfo && tsc"
}
```

The `tsconfig.tsbuildinfo` file is deleted first to ensure a clean type generation pass. `tsc`
is TypeScript 7's native compiler and reads the package's `tsconfig.json`.

Turbo runs this across the dependency graph:

```bash
bun run build:types   # Root script: turbo run build-types
```

---

## Per-Package Multi-Target Builds

### Standard Two-Target Pattern

Most packages build two runtime targets from two entry points:

```
src/browser.ts  →  dist/browser.js   (--target=browser)
src/node.ts     →  dist/node.js      (--target=node)
```

Bun is not a third target. A package's `exports` carries no `"bun"` condition, so Bun resolves
the default `"import"` and loads `dist/node.js` — which is exactly what a `src/bun.ts` identical
to `src/node.ts` would have produced. Add a `src/bun.ts`, a `--target=bun` build, and a `"bun"`
export condition only when the Bun code genuinely differs; a duplicate is a third bundle and a
third `.d.ts` to keep in sync for no behavior change. **Nothing qualifies today.** The last two
were `@workglow/util`'s `"."` and `"./worker"`, for a `Worker.bun.ts` byte-identical to
`Worker.browser.ts`: Bun implements `node:worker_threads` over the same primitive as its web
`Worker`, so a thread spawned either way is reachable through `parentPort` and one
`Worker.node.ts` serves both. `@workglow/sqlite`'s `./storage` had gone the same way earlier,
onto the shared `node:sqlite` driver. That empty set is pinned by
`packages/test/src/test/util/BunExportConditions.test.ts`, which fails in both directions — on a
`"bun"` condition added back, and on either util entry being pointed away from the node build.

Each build command follows the same template:

```bash
bun build --target=<TARGET> --sourcemap=external --packages=external --outdir ./dist ./src/<TARGET>.ts
```

Flags:

| Flag | Purpose |
|------|---------|
| `--target=browser\|node\|bun` | Tells Bun which platform APIs are available and how to resolve built-in modules |
| `--sourcemap=external` | Generates `.js.map` files alongside output for debugging |
| `--packages=external` | Leaves all `import` statements as-is (no bundling of dependencies) |
| `--outdir ./dist` | Output directory |

The `--packages=external` flag is critical — it prevents Bun from inlining dependency code into
the output, which would defeat the purpose of the monorepo's package boundaries and make
tree-shaking impossible for downstream consumers.

### Extended Pattern (util)

`@workglow/util` has additional entry points beyond the standard two. Each sub-path export gets
its own build:

```
src/schema-entry.ts    →  dist/schema-entry.js    (--target=browser)
src/graph-entry.ts     →  dist/graph-entry.js     (--target=browser)
src/media-browser.ts   →  dist/media-browser.js   (--target=browser)
src/media-node.ts      →  dist/media-node.js      (--target=node)
src/compress-browser.ts → dist/compress-browser.js (--target=browser)
src/compress-node.ts   →  dist/compress-node.js    (--target=node)
src/worker-browser.ts  →  dist/worker-browser.js   (--target=browser)
src/worker-node.ts     →  dist/worker-node.js      (--target=node, also serves Bun)
```

Platform-agnostic sub-paths (schema, graph) are built with `--target=browser` since browser-safe
code runs everywhere. Platform-specific sub-paths (media, compress, worker) are built with the
matching target for each variant.

### Provider Pattern (vendor packages under `providers/*`)

Each vendor provider package (e.g. `@workglow/anthropic`, `@workglow/openai`) uses `--root ./src`
to build the `ai` and `ai-runtime` entry points in a single invocation while
preserving their subdirectory structure in the output:

```bash
bun build --sourcemap=external --packages=external --root ./src --outdir ./dist \
  ./src/ai.ts \
  ./src/ai-runtime.ts
```

This produces output like:

```
dist/
  provider-anthropic/
    index.js
    runtime.js
  provider-gemini/
    index.js
    runtime.js
  ...
```

A separate browser build handles providers that have browser-specific implementations:

```bash
bun build --target=browser --sourcemap=external --packages=external --outdir ./dist \
  ./src/provider-ollama/index.browser.ts \
  ./src/provider-openai/index.browser.ts \
  ./src/provider-tf-mediapipe/index.ts \
  # ...
```

### Storage Backend Pattern (`providers/*`)

Storage backend packages build one set of entry points per sub-path export:

```
src/storage/browser.ts    →  dist/storage/browser.js    (--target=browser)
src/storage/node.ts       →  dist/storage/node.js       (--target=node)
src/job-queue/browser.ts  →  dist/job-queue/browser.js  (--target=browser)
src/job-queue/node.ts     →  dist/job-queue/node.js     (--target=node)
```

No storage backend has a Bun build. Every server sub-path here — including `@workglow/sqlite`'s
`./storage`, which now drives the built-in `node:sqlite` on both runtimes — is runtime-agnostic
and serves Bun from the Node build, as do all sub-paths of `@workglow/postgres` /
`@workglow/supabase` / `@workglow/aws` / `@workglow/duckdb`.

Note that the output directories for sub-paths (`dist/storage/`, `dist/job-queue/`) use
`--outdir ./dist/storage` etc. to place them in nested directories matching the sub-path export
structure.

---

## Type Generation

Type declarations are generated by a separate `build-types` step using `tsc`, which in
TypeScript 7 is the native compiler. This is deliberately separate from the JavaScript compilation because:

1. **`bun build` does not emit `.d.ts` files** — it only produces JavaScript.
2. **Type checking benefits from incremental builds** — the `composite` and `incremental` settings
   in `tsconfig.json` enable `.tsbuildinfo` caching.
3. **Cross-package references need ordered compilation** — Turbo's `^build-types` dependency
   ensures upstream types are available before downstream packages attempt to resolve them.

The root `tsconfig.json` establishes the base configuration inherited by all packages:

```json
{
  "compilerOptions": {
    "module": "esnext",
    "target": "esnext",
    "moduleResolution": "bundler",
    "composite": true,
    "strict": true,
    "declaration": true,
    "emitDeclarationOnly": true,
    "declarationMap": false,
    "incremental": true
  }
}
```

Key settings:

- `emitDeclarationOnly: true` — only `.d.ts` files are emitted (JavaScript is handled by `bun build`)
- `declarationMap: false` — skip `.d.ts.map` files; published `.d.ts` is the navigation target
- `composite: true` + `incremental: true` — enables project references and build caching
- `moduleResolution: "bundler"` — resolves imports the way modern bundlers do (supports conditional exports)

Each package's `tsconfig.json` extends the root and specifies its entry points:

```json
{
  "extends": "../../tsconfig.json",
  "files": [
    "./src/node.ts",
    "./src/browser.ts"
  ],
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

---

## Conditional Exports

The build system produces multiple artifacts per package, and the `"exports"` field in
`package.json` tells runtimes and bundlers which artifact to load. The standard pattern:

```json
{
  "exports": {
    ".": {
      "react-native": { "types": "./dist/browser.d.ts", "import": "./dist/browser.js" },
      "browser":      { "types": "./dist/browser.d.ts", "import": "./dist/browser.js" },
      "types": "./dist/node.d.ts",
      "import": "./dist/node.js"
    }
  }
}
```

The condition evaluation order matters. Runtimes and bundlers match the first condition they
support:

1. **React Native** tooling matches `"react-native"` and gets the browser build.
2. **Browser bundlers** (Vite, webpack, esbuild) match `"browser"`.
3. **Bun**, **Node.js**, and everything else falls through to the top-level `"import"` (Node
   build). A package whose Bun code genuinely differs inserts a `"bun"` condition ahead of the
   fallback; most do not.

Each condition block includes `"types"` so TypeScript resolves platform-appropriate type
declarations. This is important because `.d.ts` files may differ across platforms — for example,
the browser build exports `globalThis.Worker` while the Node build exports a `WorkerPolyfill`
with a different constructor signature.

**A block's `"types"` must name the declaration of the implementation in that same block.**
`tsgo` compiles all of `src/**/*`, so every entry file already has its own `.d.ts` in `dist` —
there is never a reason to borrow another target's. A block that points `"browser"` at the node
`.d.ts` type-checks browser consumers against the node build: they get autocomplete and
successful compiles for symbols that are `undefined` at runtime, because the browser bundle
never exported them. `packages/test/src/test/util/ExportTypesPairing.test.ts` walks every
condition branch of every workspace manifest and fails on any pair that has drifted apart.

**TypeScript applies the `"browser"` condition only when the consumer asks for it.** Its condition
set is `["import", "types"]` under `moduleResolution: "bundler"` and `["node", "import", "types"]`
under `node16`/`nodenext` — `"browser"` is in neither. A Vite or webpack app therefore _bundles_
`dist/browser.js` while `tsc` resolves the outer `"types"` and type-checks it against the node
declaration. Correct manifests do not fix that on their own; they move the drift from the manifest
to the consumer's tsconfig. Browser consumers must opt in:

```json
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "customConditions": ["browser"]
  }
}
```

`examples/web/tsconfig.json` is the in-repo example. Downstream apps that bundle for the browser
need the same line — without it, `import { _testOnly } from "@workglow/openai/ai"` compiles with
full autocomplete and is `undefined` at runtime.

CI proves that condition still resolves. The `Typecheck the browser condition` step in
`test.yml`'s `typecheck-budget` job runs `bun run typecheck:browser`, which compiles
`packages/test/src/browser-conditions/browserConditionResolution.types.ts` under
`customConditions: ["browser"]` — the only compiler run in CI that resolves a provider or
meta-package subpath that way. Every other browser-split guard reads manifests and barrels as
text, so an `export *` dropped from **both** halves of a pair passes them all and surfaces only
in a downstream browser app.

---

## Developer Workflow

### Full Build

```bash
bun run build              # Build everything: packages + examples (turbo run build-package build-example)
bun run build:packages     # Build packages only (turbo run build-package)
bun run rebuild            # Force rebuild everything, bypassing Turbo cache (turbo run build-package build-example --force)
```

Use `bun run rebuild` when you need to bypass Turbo's cache for a clean build. For incremental builds during
development, use the watch commands instead.

### Watch Mode

```bash
bun run watch              # Full watch: builds once, then watches all packages (concurrency 15)
bun run watch:js           # Watch JS only (no type watching)
```

Watch mode first runs a full `build-package` to establish a baseline, then starts `bun build --watch`
processes for each target in each package. Turbo manages these as persistent tasks with
`"persistent": true` and `"cache": false`.

For watching a single package during focused development:

```bash
cd packages/task-graph && bun run watch
```

This starts concurrent watch processes for browser, node, bun, and types within that package.

### Dev Mode

```bash
bun run dev                # Turbo dev mode
```

Runs `turbo run dev`, which starts any `dev` scripts defined in individual packages.

### Clean

```bash
bun run clean
```

Removes `dist/`, `node_modules/`, `.turbo/`, and `.tsbuildinfo` across all packages and examples.
This is a nuclear option — use it when the build cache is in an inconsistent state.

### Formatting

```bash
bun run format             # ESLint fix + Prettier write
```

Runs ESLint with `--fix` and Prettier with `--write` across all source files in packages and
examples.

---

## Command Reference

### Root-Level Commands

| Command | Description |
|---------|-------------|
| `bun run build` | Full build: all packages and examples via Turbo |
| `bun run build:packages` | Build all packages (no examples) |
| `bun run build:js` | Build JavaScript only (no type declarations) |
| `bun run build:types` | Build type declarations only |
| `bun run build:examples` | Build examples only (requires packages built first) |
| `bun run build:release` | Build packages only (release build; same task graph as `build:packages`) |
| `bun run rebuild` | Force rebuild everything, bypassing Turbo cache (`turbo run build-package build-example --force`) |
| `bun run watch` | Full watch mode (builds once, then watches with concurrency 15) |
| `bun run watch:js` | Watch JavaScript only (stream UI) |
| `bun run watch-types` | Watch type declarations only |
| `bun run dev` | Turbo dev mode |
| `bun run clean` | Remove all build artifacts, caches, and node_modules |
| `bun run format` | ESLint fix + Prettier write |
| `bun run test` | Run all tests via `bun scripts/test.ts` |

### Per-Package Commands

These are available within each package directory:

| Command | Description |
|---------|-------------|
| `bun run build-package` | Full package build (JS + types) |
| `bun run build-js` | Build all JS targets concurrently |
| `bun run build-types` | Generate type declarations via tsc |
| `bun run build-clean` | Remove dist/ and tsbuildinfo |
| `bun run build-browser` | Build browser target only |
| `bun run build-node` | Build Node.js target only |
| `bun run build-bun` | Build Bun target only |
| `bun run watch` | Watch all targets (JS + types) |
| `bun run watch-js` | Watch JS targets only |
| `bun run watch-types` | Watch type declarations only |
| `bun run test` | Run package-specific tests |

### Test Commands

| Command | Description |
|---------|-------------|
| `bun run test` | All tests (bun test + vitest) |
| `bun run test:bun:unit` | Bun unit tests |
| `bun run test:bun:integration` | Bun integration tests (graph, task, storage, queue, util, mcp) |
| `bun run test:vitest:unit` | Vitest unit tests |
| `bun run test:vitest:integration` | Vitest integration tests |
| `bun scripts/test.ts <section> vitest` | Run tests for a specific section via vitest |
| `bun scripts/test.ts <section> bun` | Run tests for a specific section via bun test |

### Turbo Flags

Commonly used flags when running Turbo commands directly:

| Flag | Purpose |
|------|---------|
| `--filter=<package>` | Run only for a specific package and its dependencies |
| `--concurrency N` | Limit parallel task execution |
| `--ui=stream` | Use streaming output (useful for watch mode) |
| `--dry-run` | Show what would run without executing |
| `--graph` | Generate a visual dependency graph |

To bypass Turbo's cache and rebuild everything from scratch, use `bun run rebuild`
rather than passing `--force` directly — it runs the full package and example
task graph with caching disabled.

Example: rebuild only `@workglow/task-graph` and its dependencies:

```bash
turbo run build-package --filter=@workglow/task-graph
```

---

## Workspace Configuration

The monorepo uses Bun workspaces defined in the root `package.json`:

```json
{
  "workspaces": [
    "./packages/*",
    "./examples/*"
  ]
}
```

All packages under `packages/` and `examples/` are workspace members. Bun resolves
`workspace:*` version specifiers to local packages, enabling instant linking without
publishing to a registry.

The root `package.json` also defines a `"catalog"` field that centralizes version pins for
shared dependencies (AI SDKs, database drivers, etc.). Packages reference catalog versions
with `"catalog:"` in their `peerDependencies`, ensuring consistent versions across the
monorepo without duplicating version strings.

The `"engines"` field enforces a minimum Bun version:

```json
{
  "engines": { "bun": "^1.3.11" },
  "packageManager": "bun@1.3.11"
}
```

This ensures contributors use a compatible runtime and prevents accidental use of npm or yarn
for package management.
