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
 * Candidates whose `ai-runtime` entry exports no `register*Inline` at all, each
 * with the reason.
 *
 * Such a candidate contributes NO assertion to this file: the sweep records it
 * and moves on. That is correct — there is nothing to construct, so there is no
 * class identity to check — but it has to be DECLARED, because the alternative
 * is a sweep that shrinks in silence. Nothing stood behind it: the skip was
 * surfaced only inside a message that prints on failure, and the numeric bound
 * guarding it was `> 4` against sixteen candidates, so eleven providers could
 * drop their registrar and leave this file green. Measured, not assumed —
 * renaming `registerAnthropicInline` and rebuilding the provider left every
 * assertion here passing.
 *
 * Today the sole member is `@workglow/mlx`, which exports `registerMlx` with no
 * `Inline` suffix: `MlxProvider.isAvailable` reports `false` until an mlx-lm
 * runtime is bundled, so there is nothing to register inline yet.
 */
const NO_INLINE_REGISTRAR: Readonly<Record<string, string>> = {
  "@workglow/mlx":
    "exports registerMlx rather than register*Inline — MlxProvider stays unavailable until an mlx-lm runtime is bundled, so it registers nothing",
};

/**
 * The floor the enumeration has to clear for anything below to mean something.
 *
 * Deliberately below today's sixteen — a provider may legitimately be removed —
 * but far enough above zero that a typo in the walk (wrong group key, wrong
 * subpath name) fails instead of yielding a short list every assertion passes
 * over.
 */
const MINIMUM_RUNTIME_CANDIDATES = 12;

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
 * rather than failed, and compared below against {@link NO_INLINE_REGISTRAR}
 * so a skip nobody declared fails instead of shrinking the sweep.
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
    expect(candidates.length).toBeGreaterThanOrEqual(MINIMUM_RUNTIME_CANDIDATES);
    // An EQUALITY, not a second floor: the checked set is the candidate set
    // minus exactly the declared native-runtime exemptions, so a candidate that
    // falls out of the sweep for any undeclared reason fails here.
    expect(checkable.length).toBe(candidates.length - Object.keys(NEEDS_NATIVE_RUNTIME).length);
  });

  it("keeps every exemption pinned to a package that still exists", () => {
    // An exemption that outlives its package silently exempts nothing while
    // reading as if a real hole were still open. Both maps, since either one
    // removes a candidate from the checks below.
    const known = new Set(candidates.map((c) => c.packageName));
    const maps = [
      ["NEEDS_NATIVE_RUNTIME", NEEDS_NATIVE_RUNTIME],
      ["NO_INLINE_REGISTRAR", NO_INLINE_REGISTRAR],
    ] as const;
    for (const [label, map] of maps) {
      expect(
        Object.keys(map).filter((name) => !known.has(name)),
        label
      ).toEqual([]);
      for (const [name, reason] of Object.entries(map)) {
        // A one-word reason is an exemption nobody can review.
        expect(reason.length, `${label}["${name}"]`).toBeGreaterThan(20);
      }
    }
  });

  it("declares every candidate whose runtime entry exports no register*Inline", () => {
    // The skip that was invisible: such a candidate is pushed onto this list
    // and `continue`d, contributing NO assertion, and the only place it
    // surfaced was a message that prints on failure. Comparing against the
    // declared map means a provider that drops its registrar in a refactor
    // fails here instead of quietly leaving the sweep.
    expect(
      [...withoutInlineRegistrar].sort(),
      "a runtime entry exporting no register*Inline is checked by nothing — declare it in " +
        "NO_INLINE_REGISTRAR with the reason, or restore its registrar"
    ).toEqual(Object.keys(NO_INLINE_REGISTRAR).sort());
  });

  it("registers at least one provider from every runtime entry that has a registrar", () => {
    // Replaces a `> 4` bound that fifteen registering entries cleared with
    // eleven to spare. Two statements instead of a magic number: exactly the
    // expected packages ran a registrar, and each one actually put something in
    // the registry — the per-provider assertions below iterate what
    // registration produced, so a run in which every call silently no-opped
    // would satisfy all of them.
    const expected = checkable
      .map((candidate) => candidate.packageName)
      .filter((name) => !(name in NO_INLINE_REGISTRAR))
      .sort();
    expect(registrations.map((registration) => registration.packageName).sort()).toEqual(expected);

    const registeredNothing = registrations
      .filter((registration) => registration.providerNames.length < 1)
      .map((registration) => `${registration.packageName} (via ${registration.registrarName})`);
    // Collected rather than asserted in the loop, so one no-opping registrar
    // reports itself instead of being averaged away by the fourteen that worked.
    expect(
      registeredNothing,
      `these register*Inline calls added no provider to the registry, so every per-provider ` +
        `assertion below iterates nothing for them`
    ).toEqual([]);
  });

  it("loads one AiProvider class per @workglow/ai entry point the target actually has", () => {
    // TWO-SIDED, and this is the in-process proof that the modules under test
    // are BUNDLES rather than src. `@workglow/ai` builds `.` and `./worker` as
    // separate `bun build` invocations, so under `dist` there really are two
    // distinct classes; under `source` both specifiers resolve through one
    // underlying module and there is exactly one. The old `<= 2` was satisfied
    // by either, so it could not tell a real dist run from a source run
    // mislabelled as one — nor from a stubbed `dist` re-exporting src.
    //
    // The variable read here is the one `resolveTestTarget` already validated
    // in vitest.config.ts and handed to the workers, so `=== "dist"` cannot
    // silently mean "source" for a typo the way an unvalidated read would.
    const target = process.env.WORKGLOW_TEST_TARGET ?? "source";
    expect(new Set(PUBLISHED_BASE_CLASSES).size, `WORKGLOW_TEST_TARGET=${target}`).toBe(
      target === "dist" ? 2 : 1
    );
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
