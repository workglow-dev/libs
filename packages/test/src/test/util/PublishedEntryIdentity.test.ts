/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { AiProvider, getAiProviderRegistry } from "@workglow/ai";
import { AiProvider as WorkerAiProvider } from "@workglow/ai/worker";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

/**
 * The workspace groups, derived from the root manifest's `workspaces` field.
 *
 * Duplicated derivation code rather than a duplicated list, and duplicated for
 * the same reason `PublishedEntryImports.test.ts` gives: `packages/test` is a
 * `composite` project rooted at `./src`, so importing the tooling's own copy
 * under `scripts/` would pull those files into its program and break
 * `build-types`.
 */
const WORKSPACE_GROUPS: readonly string[] = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { workspaces: string[] }
).workspaces.map((pattern) => pattern.replace(/^\.\//, "").replace(/\/?\*.*$/, ""));

/**
 * Providers whose `ai-runtime` entry cannot be registered inside a plain CI
 * job, each with the reason it cannot.
 *
 * EMPTY, and measured to be: the local providers this was expected to need —
 * `node-llama-cpp`, `huggingface-transformers`, `cactus`,
 * `stable-diffusion-server` — all register cleanly with no native runtime
 * present, because `register*Inline` only CONSTRUCTS the provider and hands its
 * run-fn table to the registry. Every SDK, native binding and server probe is
 * behind a run-fn and is reached only by an actual generation call, which this
 * file never makes. Exempting them would have been a false statement that cost
 * five of the sixteen candidates their coverage.
 *
 * The map stays as the seam for a provider that genuinely cannot register. It
 * is stated per entry and must be kept small, so a NEW provider defaults to
 * being checked — a permissive default would reopen exactly the hole this file
 * closes. Every key is proved below to still name a candidate package, so a
 * renamed or deleted provider takes its exemption with it.
 */
const NEEDS_NATIVE_RUNTIME: Readonly<Record<string, string>> = {};

/**
 * The base classes a provider is allowed to have been built from — the ones
 * `@workglow/ai` itself PUBLISHES.
 *
 * There are two, and that is deliberate rather than an oversight this test
 * papers over. `@workglow/ai` builds `.` and `./worker` as separate `bun build`
 * invocations, so each bundle carries its own copy of `AiProvider`; the worker
 * entry exists precisely so a worker bundle does not drag in the full node
 * entry, and the five providers with a worker runtime (`chrome-ai`,
 * `tf-mediapipe`, `cactus`, `huggingface-transformers`, `node-llama-cpp`)
 * extend the worker copy on purpose. Under the `source` target both specifiers
 * resolve to one file and this set collapses to a single class.
 *
 * That published split is a real cross-entry identity seam — a consumer holding
 * `AiProvider` from `@workglow/ai` and testing a Chrome AI provider with
 * `instanceof` gets `false` today — but it is pre-existing, intentional, and
 * belongs to the `@workglow/ai` build rather than to this check. What this file
 * catches is the THIRD copy: one inlined into a provider's own `ai-runtime`
 * bundle, which matches neither published class.
 */
const PUBLISHED_BASE_CLASSES = [AiProvider, WorkerAiProvider] as const;

interface RuntimeCandidate {
  /** The package that publishes both `./ai` and `./ai-runtime`. */
  readonly packageName: string;
  /** The `ai-runtime` specifier a consumer writes. */
  readonly specifier: string;
}

/** Every workspace package publishing BOTH an `./ai` and an `./ai-runtime` entry. */
function collectRuntimeCandidates(): RuntimeCandidate[] {
  const candidates: RuntimeCandidate[] = [];
  for (const group of WORKSPACE_GROUPS) {
    let directories: string[];
    try {
      directories = readdirSync(join(repoRoot, group));
    } catch {
      continue;
    }
    for (const directory of directories) {
      let manifest: { name?: unknown; exports?: unknown };
      try {
        manifest = JSON.parse(
          readFileSync(join(repoRoot, group, directory, "package.json"), "utf8")
        );
      } catch {
        continue; // not a package directory
      }
      const { name, exports } = manifest;
      if (typeof name !== "string") continue;
      if (typeof exports !== "object" || exports === null || Array.isArray(exports)) continue;
      const subpaths = Object.keys(exports as Record<string, unknown>);
      // Both halves matter: `./ai` holds the class hierarchy every consumer
      // holds, `./ai-runtime` holds the registration that constructs into it.
      // A package publishing only one of them cannot exhibit the split.
      if (!subpaths.includes("./ai") || !subpaths.includes("./ai-runtime")) continue;
      candidates.push({ packageName: name, specifier: `${name}/ai-runtime` });
    }
  }
  return candidates.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

const candidates = collectRuntimeCandidates();
const checkable = candidates.filter((c) => !(c.packageName in NEEDS_NATIVE_RUNTIME));

/** What one package's `register*Inline` actually put into the registry. */
interface Registration {
  readonly packageName: string;
  /** The `register*Inline` export that was called. */
  readonly registrarName: string;
  /** Registry keys that appeared as a result of calling it. */
  readonly providerNames: readonly string[];
}

const registrations: Registration[] = [];
/**
 * Packages whose `ai-runtime` exports no `register*Inline` at all — skipped
 * rather than failed, and reported in the anti-vacuity message below so a
 * silently shrinking sweep is visible. Today that is `@workglow/mlx`, whose
 * `registerMlx` deliberately returns without touching the registry until an
 * mlx-lm runtime is bundled.
 */
const withoutInlineRegistrar: string[] = [];

/**
 * What this file is actually checking, and why the obvious version of it is
 * vacuous.
 *
 * The failure mode is CLASS identity across bundle boundaries, exactly as
 * `packages/task-graph/src/test-entry.ts` documents it. `registerAnthropicInline`
 * constructs `new AnthropicQueuedProvider(...)` from a RELATIVE import inside the
 * `ai-runtime` module graph, while that class extends a base built from
 * `AiProvider` imported BY SPECIFIER. Inline `@workglow/ai` into
 * `ai-runtime.js` — a bundler flag, a dropped `external`, a re-export rewritten
 * from `export *` to `export { … } from` — and the constructed instance stops
 * being `instanceof` the `AiProvider` every consumer holds, while every
 * existing check stays green.
 *
 * Asserting on the SERVICE REGISTRY instead would prove nothing: the global DI
 * container is stashed on `Symbol.for("@workglow/util/di/globalContainer")`
 * (`packages/util/src/di/Container.ts`) precisely so duplicated bundle copies
 * share one instance, and `createServiceToken` returns a plain string id. A
 * duplicated `@workglow/ai` therefore resolves the SAME registry, and a `===`
 * assertion on it is green by construction.
 *
 * Under the default `source` target this file passes trivially — every
 * specifier resolves to `src`, so there is only ever one copy of every class. A
 * green source run is therefore NOT a bundle check. The run that means
 * something is `test-vitest-dist` (`WORKGLOW_TEST_TARGET=dist`), which is why
 * this is a unit-tier file: that is the tier the dist job runs.
 *
 * It is affordable there because `register*Inline` needs NO API key. It
 * constructs the provider and calls `registerProviderInline`, which calls
 * `provider.register(...)` — registry bookkeeping and a strategy resolver, no
 * network. Putting this on an integration tier instead would have cost real
 * money for no extra signal, and would have been skipped entirely on fork PRs,
 * where the secrets those suites gate on are unavailable.
 */
describe("published entry identity", () => {
  beforeAll(async () => {
    const registry = getAiProviderRegistry();
    for (const candidate of checkable) {
      const loaded: Record<string, unknown> = await import(/* @vite-ignore */ candidate.specifier);
      const registrarName = Object.keys(loaded).find((key) => /^register\w+Inline$/.test(key));
      if (registrarName === undefined) {
        withoutInlineRegistrar.push(candidate.packageName);
        continue;
      }
      const before = new Set(registry.getProviders().keys());
      await (loaded[registrarName] as () => Promise<void>)();
      registrations.push({
        packageName: candidate.packageName,
        registrarName,
        providerNames: [...registry.getProviders().keys()].filter((name) => !before.has(name)),
      });
    }
  });

  it("enumerates the providers that publish both an ai and an ai-runtime entry", () => {
    // Anti-vacuity. A typo in the walk (wrong group key, wrong subpath name)
    // yields a SHORT list rather than an error, and every assertion below
    // passes over a short list — including over an empty one.
    expect(candidates.length).toBeGreaterThan(4);
    expect(checkable.length).toBeGreaterThan(4);
  });

  it("keeps every exemption pinned to a package that still exists", () => {
    // An exemption that outlives its package silently exempts nothing while
    // reading as if a real hole were still open.
    const known = new Set(candidates.map((c) => c.packageName));
    expect(Object.keys(NEEDS_NATIVE_RUNTIME).filter((name) => !known.has(name))).toEqual([]);
    for (const reason of Object.values(NEEDS_NATIVE_RUNTIME)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it("registers a provider from more than a handful of runtime entries", () => {
    // The anti-vacuity guard that matters: the per-provider assertions below
    // iterate what registration actually produced, so a run in which every
    // registration silently no-opped would satisfy all of them.
    const providers = getAiProviderRegistry().getProviders();
    expect(
      providers.size,
      `only ${providers.size} provider(s) registered from ${checkable.length} runtime entries. ` +
        `Entries exporting no register*Inline: ${withoutInlineRegistrar.join(", ") || "(none)"}`
    ).toBeGreaterThan(4);
  });

  it("publishes no more base classes than @workglow/ai has entry points", () => {
    // Guards the allowance above from growing quietly. One class under the
    // `source` target (both specifiers are one file), two under `dist` (`.` and
    // `./worker` are separate bundles). A third would mean a new split nobody
    // decided on.
    expect(new Set(PUBLISHED_BASE_CLASSES).size).toBeLessThanOrEqual(2);
  });

  it("constructs every provider from an AiProvider class @workglow/ai publishes", () => {
    // THE check. A provider built against a copy of `AiProvider` inlined into
    // its own runtime bundle is a perfectly functional object that fails this
    // and nothing else — no other assertion anywhere distinguishes it.
    const registry = getAiProviderRegistry();
    const offenders: string[] = [];
    for (const { packageName, registrarName, providerNames } of registrations) {
      for (const providerName of providerNames) {
        const provider = registry.getProvider(providerName);
        expect(
          provider,
          `${packageName}: ${registrarName}() registered "${providerName}" but the registry has no such provider`
        ).toBeDefined();
        if (!PUBLISHED_BASE_CLASSES.some((base) => provider instanceof base)) {
          offenders.push(`${packageName} -> ${providerName} (via ${registrarName})`);
        }
      }
    }
    // Collected rather than asserted in the loop, so one bad bundle reports
    // itself instead of hiding every provider sorted after it.
    expect(
      offenders,
      `these providers are not an instanceof any AiProvider that @workglow/ai publishes, which is ` +
        `the signature of @workglow/ai being INLINED into the provider's own ai-runtime bundle ` +
        `instead of left external: the runtime graph built its provider on a private copy of the ` +
        `base class, so every consumer's instanceof check now returns false`
    ).toEqual([]);
  });

  it("registers at least one run function per registered provider", () => {
    // `instanceof` alone would still pass for a bundle that lost its run-fn
    // module: the provider object is intact and serves nothing.
    const registry = getAiProviderRegistry();
    const empty: string[] = [];
    for (const { packageName, providerNames } of registrations) {
      for (const providerName of providerNames) {
        if (registry.getRunFnRegistrations(providerName).length === 0) {
          empty.push(`${packageName} -> ${providerName}`);
        }
      }
    }
    expect(empty).toEqual([]);
  });
});
