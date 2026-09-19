/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Capability } from "@workglow/ai/worker";
import {
  CACTUS_DEFAULT_HF_REPO,
  CACTUS_DEFAULT_REVISION,
  CACTUS_NEEDLE_26M,
  CACTUS_NEEDLE_V2,
  CACTUS_NEEDLE_V3,
  CACTUS_V2_HF_REPO,
  CACTUS_V3_HF_REPO,
} from "./Cactus_Constants";
import { CACTUS_HASH_PLACEHOLDER } from "./Cactus_Integrity";

/**
 * A single asset file in a Cactus model catalog entry.
 *
 * `sha256` is the lowercase-hex digest of the canonical asset bytes at the
 * pinned `revision` in `CactusCatalogEntry`. It anchors the trust boundary:
 * any byte that fails this check is treated as adversarial and refused.
 */
export interface CactusAssetSpec {
  readonly filename: string;
  /**
   * Lowercase hex SHA-256, exactly 64 characters.
   *
   * The literal string `"TODO_FILL_AT_RELEASE"` is accepted as a placeholder
   * during pre-release development; in that case `verifySha256` skips the
   * check and logs a one-time warning. The placeholder MUST be replaced
   * with a real hash before a tagged release.
   */
  readonly sha256: string;
  /** Expected byte length — used as a cheap pre-check before hashing. */
  readonly size: number;
}

interface CactusCatalogEntryBase {
  readonly model_id: string;
  readonly title: string;
  readonly description: string;
  readonly hf_repo: string;
  readonly revision: string;
  readonly capabilities: readonly Capability[];
}

export interface CactusV1CatalogEntry extends CactusCatalogEntryBase {
  readonly generation: 1;
  readonly assets: {
    readonly weights: CactusAssetSpec;
    readonly vocab: CactusAssetSpec;
    readonly config: CactusAssetSpec;
  };
}

export interface CactusV2CatalogEntry extends CactusCatalogEntryBase {
  readonly generation: 2;
  readonly assets: {
    readonly cact: CactusAssetSpec;
  };
}

/**
 * Needle 3 ships the same single-`.cact` shape as v2, but the containers are
 * not interchangeable: `NeedleV3Wasm.load` refuses v2 bytes and vice versa, so
 * the generation stays an explicit discriminant rather than a size heuristic.
 */
export interface CactusV3CatalogEntry extends CactusCatalogEntryBase {
  readonly generation: 3;
  readonly assets: {
    readonly cact: CactusAssetSpec;
  };
}

export type CactusCatalogEntry = CactusV1CatalogEntry | CactusV2CatalogEntry | CactusV3CatalogEntry;

/**
 * Asserts that `s` is a lowercase hex SHA-256 (64 hex chars).
 *
 * Invoked at module-load time on every non-placeholder catalog entry (see
 * the bottom of this file) so malformed hashes surface immediately as an
 * import-time error rather than the first time `verifySha256` runs against
 * fetched bytes.
 */
export function assertHexSha256(s: string, ctxLabel?: string): asserts s is string {
  if (typeof s !== "string" || s.length !== 64 || !/^[0-9a-f]{64}$/.test(s)) {
    throw new Error(
      `Invalid SHA-256 in catalog${ctxLabel ? ` (${ctxLabel})` : ""}: ` +
        `expected 64 lowercase hex chars, got ${JSON.stringify(s)}`
    );
  }
}

export const CACTUS_CATALOG: readonly CactusCatalogEntry[] = [
  {
    model_id: CACTUS_NEEDLE_26M,
    title: "Needle 26M",
    description:
      "Specialized 26M-parameter tool-routing transformer. INT4 SafeTensors, 22 MB. Runs via WASM in browser and Node/Bun.",
    hf_repo: CACTUS_DEFAULT_HF_REPO,
    revision: CACTUS_DEFAULT_REVISION,
    generation: 1,
    assets: {
      // MAINTAINER: regenerate hashes after bumping `revision` by running
      //   bun run --filter @workglow/cactus hash-catalog -- --write
      // The script fetches each asset URL, computes sha256, and rewrites
      // these blocks in place. Production / CACTUS_REQUIRE_REAL_HASHES=1
      // refuse to load the catalog while any value is still the placeholder.
      weights: {
        filename: "needle.safetensors",
        sha256: "87bbc354a99d26bf3763a845fbaf7118bd1e42aa9f675f1422fb79cde5ae0f4d",
        size: 22259039,
      },
      vocab: {
        filename: "vocab.txt",
        sha256: "37643f32cb6ee4c636be3098a044c32d652d902553bf84e734bfdd56fb34b43b",
        size: 122132,
      },
      config: {
        filename: "config.json",
        sha256: "57adb8eebbabf2bf514d13ed695e9572efcddc0cd251bcfc166c01f0c7b01440",
        size: 320,
      },
    },
    capabilities: ["tool-use"],
  },
  {
    model_id: CACTUS_NEEDLE_V2,
    title: "Needle 2",
    description:
      "Needle v2 tool-routing transformer. Single 14 MB .cact image (weights, geometry, tokenizer). Runs via WASM in browser and Node/Bun.",
    hf_repo: CACTUS_V2_HF_REPO,
    revision: CACTUS_DEFAULT_REVISION,
    generation: 2,
    assets: {
      // MAINTAINER: regenerate hashes after bumping `revision` by running
      //   bun run --filter @workglow/cactus hash-catalog -- --write
      cact: {
        filename: "needle2.cact",
        sha256: "b43aabfcaf1a6db6acf488076eab71d823c08697c7af4521fc1d174b60ede5ba",
        size: 13737807,
      },
    },
    capabilities: ["tool-use"],
  },
  {
    model_id: CACTUS_NEEDLE_V3,
    title: "Needle 3",
    description:
      "Needle v3 tool-routing transformer. Single 35 MB .cact image (weights, geometry, tokenizer). Reasons before answering. Runs via WASM in browser and Node/Bun.",
    hf_repo: CACTUS_V3_HF_REPO,
    revision: CACTUS_DEFAULT_REVISION,
    generation: 3,
    assets: {
      // MAINTAINER: regenerate hashes after bumping `revision` by running
      //   bun run --filter @workglow/cactus hash-catalog -- --write
      cact: {
        filename: "needle3.cact",
        sha256: "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38",
        size: 35335380,
      },
    },
    capabilities: ["tool-use"],
  },
] as const;

export function getCactusCatalogEntry(model_id: string): CactusCatalogEntry | undefined {
  return CACTUS_CATALOG.find((e) => e.model_id === model_id);
}

/** Asset specs for download/cache: v1 is weights, vocab, config; v2 and v3 are the .cact image. */
export function assetSpecsOf(entry: CactusCatalogEntry): readonly CactusAssetSpec[] {
  if (entry.generation === 2 || entry.generation === 3) {
    return [entry.assets.cact];
  }
  return [entry.assets.weights, entry.assets.vocab, entry.assets.config];
}

export function cactusAssetUrl(
  entry: CactusCatalogEntry,
  filenameOrSpec: string | CactusAssetSpec
): string {
  const filename = typeof filenameOrSpec === "string" ? filenameOrSpec : filenameOrSpec.filename;
  return `https://huggingface.co/${entry.hf_repo}/resolve/${entry.revision}/${filename}`;
}

// ============================================================================
// Module-load invariants
//
//   1. Every non-placeholder catalog entry has a valid 64-char lowercase hex
//      SHA-256. Catches catalog-author typos immediately at import time.
//   2. In production (or when CACTUS_REQUIRE_REAL_HASHES=1 is set
//      explicitly), reject any placeholder hash or zero-sized asset. Dev
//      and test runs stay permissive so contributors can iterate before
//      the real hashes have been populated.
//
// `CATALOG_HAS_PLACEHOLDERS` is exported so tooling (release gates, CI
// pre-flight checks) can opt-in to the same assertion without re-reading
// the catalog.
// ============================================================================
function detectCatalogPlaceholders(): boolean {
  for (const entry of CACTUS_CATALOG) {
    for (const asset of assetSpecsOf(entry)) {
      if (asset.sha256 === CACTUS_HASH_PLACEHOLDER || asset.size <= 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * `true` when at least one catalog entry still uses the
 * `CACTUS_HASH_PLACEHOLDER` sentinel or has a non-positive `size`. Computed
 * once at module load. Release tooling can assert `!CATALOG_HAS_PLACEHOLDERS`
 * before publishing a tag.
 */
export const CATALOG_HAS_PLACEHOLDERS: boolean = detectCatalogPlaceholders();

for (const entry of CACTUS_CATALOG) {
  for (const asset of assetSpecsOf(entry)) {
    if (asset.sha256 !== CACTUS_HASH_PLACEHOLDER) {
      assertHexSha256(asset.sha256, `${entry.model_id}/${asset.filename}`);
    }
  }
}

// Production guard. Read the env vars defensively — `process` may not exist
// in pure-browser runtimes, and we don't want the module to crash there.
const _env: Record<string, string | undefined> =
  typeof process !== "undefined" && process.env ? process.env : {};
if (_env.NODE_ENV === "production" || _env.CACTUS_REQUIRE_REAL_HASHES === "1") {
  for (const entry of CACTUS_CATALOG) {
    for (const asset of assetSpecsOf(entry)) {
      if (asset.sha256 === CACTUS_HASH_PLACEHOLDER) {
        throw new Error(
          `Cactus catalog entry ${entry.model_id}/${asset.filename} ` +
            `still uses the SHA-256 placeholder; populate with ` +
            `providers/cactus/scripts/hash-catalog.ts before publishing.`
        );
      }
      if (asset.size <= 0) {
        throw new Error(
          `Cactus catalog entry ${entry.model_id}/${asset.filename} ` +
            `has non-positive size (${asset.size}); populate with ` +
            `providers/cactus/scripts/hash-catalog.ts before publishing.`
        );
      }
    }
  }
}
