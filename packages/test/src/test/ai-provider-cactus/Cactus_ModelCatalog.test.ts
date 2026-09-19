/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Module-load guards for `CACTUS_CATALOG`:
 *
 *   1. Without `CACTUS_REQUIRE_REAL_HASHES`, the catalog loads even when
 *      placeholder hashes are present — developer-friendly default during
 *      pre-release iteration.
 *   2. With `CACTUS_REQUIRE_REAL_HASHES=1`, the module load throws if ANY
 *      asset is still on the `CACTUS_HASH_PLACEHOLDER` sentinel or has a
 *      non-positive `size`. This is the gate release tooling can flip on
 *      before publishing.
 *
 * The test temporarily mutates the catalog source through Bun's `import()`
 * resolver. We avoid `vi.mock` because mocking the module from outside while
 * also exercising its module-load side effects is brittle across runners;
 * instead we drive the assertions by directly invoking the same validation
 * predicate (`CATALOG_HAS_PLACEHOLDERS`) and by spawning a child process
 * with the env var set so the import-time throw is observable.
 */

import {
  _testOnly,
  assetSpecsOf,
  CACTUS_CATALOG,
  CATALOG_HAS_PLACEHOLDERS,
} from "@workglow/cactus/ai";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const { CACTUS_HASH_PLACEHOLDER } = _testOnly;

describe("Cactus_ModelCatalog module-load guards", () => {
  it("loads cleanly without CACTUS_REQUIRE_REAL_HASHES (dev-friendly default)", () => {
    // Reaching this line at all means the module loaded — the test imports
    // the catalog at the top of the file. The catalog must be non-empty and
    // every entry must expose at least one asset spec.
    expect(CACTUS_CATALOG.length).toBeGreaterThan(0);
    for (const entry of CACTUS_CATALOG) {
      expect(assetSpecsOf(entry).length).toBeGreaterThan(0);
    }
  });

  it("includes a Needle v3 catalog entry with a single .cact asset", () => {
    const v3 = CACTUS_CATALOG.find((entry) => entry.generation === 3);
    expect(v3).toBeDefined();
    expect(v3?.model_id).toBe("needle-v3");
    expect(v3?.hf_repo).toBe("Cactus-Compute/needle3");
    expect(v3 && "cact" in v3.assets).toBe(true);
    if (v3 && "cact" in v3.assets) {
      expect(v3.assets.cact.filename).toBe("needle3.cact");
      expect(v3.assets.cact.size).toBeGreaterThan(0);
    }
    expect(assetSpecsOf(v3!).length).toBe(1);
  });

  it("keeps the v2 and v3 .cact assets distinct", () => {
    const v2 = CACTUS_CATALOG.find((entry) => entry.generation === 2);
    const v3 = CACTUS_CATALOG.find((entry) => entry.generation === 3);
    const [v2Asset] = assetSpecsOf(v2!);
    const [v3Asset] = assetSpecsOf(v3!);
    // Same extension, different container: a shared filename or digest would
    // mean one generation's bytes are cached under the other's key.
    expect(v2Asset.filename).not.toBe(v3Asset.filename);
    expect(v2Asset.sha256).not.toBe(v3Asset.sha256);
  });

  it("includes a Needle v2 catalog entry with a single .cact asset", () => {
    const v2 = CACTUS_CATALOG.find((entry) => entry.generation === 2);
    expect(v2).toBeDefined();
    expect(v2?.model_id).toBe("needle-v2");
    expect(v2 && "cact" in v2.assets).toBe(true);
    if (v2 && "cact" in v2.assets) {
      expect(v2.assets.cact.filename).toMatch(/\.cact$/);
      expect(v2.assets.cact.size).toBeGreaterThan(0);
    }
    expect(assetSpecsOf(v2!).length).toBe(1);
  });

  it("keeps the Needle v1 catalog entry with weights, vocab, and config", () => {
    const v1 = CACTUS_CATALOG.find((entry) => entry.generation === 1);
    expect(v1).toBeDefined();
    expect(v1?.model_id).toBe("needle-26m");
    expect(v1 && "weights" in v1.assets).toBe(true);
    expect(assetSpecsOf(v1!).length).toBe(3);
  });

  it("exports CATALOG_HAS_PLACEHOLDERS that reflects current catalog state", () => {
    // The boolean is computed at module load. With real hashes populated it
    // must be `false`; if any asset still uses the placeholder OR has a
    // non-positive size, it must be `true`.
    let expected = false;
    for (const entry of CACTUS_CATALOG) {
      for (const asset of assetSpecsOf(entry)) {
        if (asset.sha256 === CACTUS_HASH_PLACEHOLDER || asset.size <= 0) {
          expected = true;
        }
      }
    }
    expect(CATALOG_HAS_PLACEHOLDERS).toBe(expected);
  });

  it("CACTUS_REQUIRE_REAL_HASHES=1 throws when a placeholder is present", () => {
    // Spawn a child process that:
    //   - injects a stubbed Cactus_Integrity that exposes the placeholder
    //     under the constant the catalog imports, then
    //   - injects a temporary catalog source whose first asset's sha256 is
    //     the placeholder and size=0, then
    //   - imports the module under CACTUS_REQUIRE_REAL_HASHES=1.
    // We assert the child exits non-zero. To avoid file mutation in the
    // working tree, we use a TS evaluator script that constructs the
    // placeholder situation inline by re-importing the constants and
    // running the guard predicate directly.
    const here = dirname(fileURLToPath(import.meta.url));
    const evaluator = resolve(here, "../helpers/cactus-placeholder-guard-runner.ts");
    const result = spawnSync("bun", [evaluator], {
      env: { ...process.env, CACTUS_REQUIRE_REAL_HASHES: "1" },
      encoding: "utf8",
    });
    // Either the catalog actually throws at import time (real placeholders
    // present in CACTUS_CATALOG), or the runner forces a placeholder and
    // re-runs the guard logic itself. Either way the runner exits non-zero
    // when the guard would reject.
    expect(result.status).not.toBe(0);
    expect((result.stderr ?? "") + (result.stdout ?? "")).toMatch(/placeholder|non-positive size/i);
  });

  it("Without CACTUS_REQUIRE_REAL_HASHES the guard runner exits 0", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const evaluator = resolve(here, "../helpers/cactus-placeholder-guard-runner.ts");
    const env = { ...process.env };
    delete env.CACTUS_REQUIRE_REAL_HASHES;
    delete env.NODE_ENV;
    const result = spawnSync("bun", [evaluator], { env, encoding: "utf8" });
    expect(result.status).toBe(0);
  });
});
