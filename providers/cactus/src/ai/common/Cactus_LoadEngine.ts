/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { assetSpecsOf, type CactusAssetSpec, type CactusCatalogEntry } from "./Cactus_ModelCatalog";

export type NeedleSdkModule = typeof import("needle-rs");

export type NeedleEngine =
  | NonNullable<ReturnType<NeedleSdkModule["NeedleWasm"]["load"]>>
  | NonNullable<ReturnType<NeedleSdkModule["NeedleV2Wasm"]["load"]>>
  | NonNullable<ReturnType<NeedleSdkModule["NeedleV3Wasm"]["load"]>>;

/**
 * Builds the engine for a catalog entry from bytes already fetched and
 * verified, keyed by asset filename.
 *
 * The branch is on `entry.generation`, the union's declared discriminant, so a
 * generation added to the catalog without a loader here fails to type-check
 * rather than silently falling into the nearest-looking branch.
 */
export function loadCactusEngine(
  sdk: NeedleSdkModule,
  entry: CactusCatalogEntry,
  files: Readonly<Record<string, Uint8Array>>
): NeedleEngine {
  if (entry.generation === 3) {
    const bytes = files[entry.assets.cact.filename];
    if (!bytes) {
      throw new Error(
        `Missing Cactus v3 asset ${entry.assets.cact.filename} for model ${entry.model_id}`
      );
    }
    // `load` rejects a v2 container rather than misreading it, so an undefined
    // here means the bytes are not a v3 image — a catalog/asset mismatch.
    const engine = sdk.NeedleV3Wasm.load(bytes);
    if (!engine) {
      throw new Error(`needle-rs NeedleV3Wasm.load returned undefined for model ${entry.model_id}`);
    }
    return engine;
  }

  if (entry.generation === 2) {
    const bytes = files[entry.assets.cact.filename];
    if (!bytes) {
      throw new Error(
        `Missing Cactus v2 asset ${entry.assets.cact.filename} for model ${entry.model_id}`
      );
    }
    const engine = sdk.NeedleV2Wasm.load(bytes);
    if (!engine) {
      throw new Error(`needle-rs NeedleV2Wasm.load returned undefined for model ${entry.model_id}`);
    }
    return engine;
  }

  const weightsBytes = files[entry.assets.weights.filename];
  const vocabBytes = files[entry.assets.vocab.filename];
  if (!weightsBytes || !vocabBytes) {
    throw new Error(`Missing Cactus v1 weights/vocab for model ${entry.model_id}`);
  }
  const vocabText = new TextDecoder().decode(vocabBytes);
  const engine = sdk.NeedleWasm.load(weightsBytes, vocabText);
  if (!engine) {
    throw new Error(`needle-rs NeedleWasm.load returned undefined for model ${entry.model_id}`);
  }
  return engine;
}

export interface LoadedCactusModel {
  readonly engine: NeedleEngine;
  /**
   * Parsed `config.json` for a v1 model, or `null` for v2 and v3 — whose
   * geometry and tokenizer travel inside the `.cact` image — and for a config
   * that failed to parse.
   */
  readonly configJson: unknown;
}

function parseConfigJson(bytes: Uint8Array | undefined): unknown {
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Fetches every asset a catalog entry declares and loads the engine from them.
 * `fetchAsset` is the caller's runtime-specific verified fetch (filesystem in
 * Node, Cache Storage in the browser); everything downstream of it is shared.
 */
export async function loadCactusModel(
  sdk: NeedleSdkModule,
  entry: CactusCatalogEntry,
  fetchAsset: (spec: CactusAssetSpec) => Promise<Uint8Array>
): Promise<LoadedCactusModel> {
  const specs = assetSpecsOf(entry);
  const blobs = await Promise.all(specs.map((spec) => fetchAsset(spec)));
  const files: Record<string, Uint8Array> = Object.fromEntries(
    specs.map((spec, i) => [spec.filename, blobs[i]!])
  );
  const configJson =
    entry.generation === 1 ? parseConfigJson(files[entry.assets.config.filename]) : null;
  return { engine: loadCactusEngine(sdk, entry, files), configJson };
}
