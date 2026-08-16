/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vector quantization by randomized rotation plus uniform scalar quantization.
 *
 * THE NAME REFERS TO THE BORROWED ROTATION STRATEGY, not to the paper's quantizer or its
 * distortion bound — what ships here is a classical construction that predates the paper.
 *
 * Inspired by "TurboQuant: Online Vector Quantization with Near-optimal Distortion Rate"
 * by Zandieh, Daliri, Hadian, and Mirrokni (2025), arXiv:2504.19874.
 *
 * Why rotate: a random orthogonal rotation spreads a vector's energy evenly over its
 * coordinates, so no coordinate dominates and every coordinate ends up with the same
 * approximately Gaussian marginal. One fixed quantization grid then fits every
 * coordinate of every vector, with no training pass and no per-dataset codebook.
 *
 * What this module implements: the randomized Hadamard rotation, plus a UNIFORM scalar
 * quantizer whose clipping range is the MSE-optimal loading factor for a unit-variance
 * Gaussian at the given bit width. Reconstruction is renormalized back to the recorded
 * L2 norm, which keeps reconstructed MAGNITUDE unbiased.
 *
 * What it does NOT implement: the paper's non-uniform, distribution-fitted (Beta) level
 * placement — the contribution that buys the near-optimal distortion rate. Distortion here
 * is that of an optimal *uniform* quantizer, which is coarser.
 *
 * ## Two encoders; only one has a storage path
 *
 * This module ships two independent encoders, and they are not interchangeable in where
 * their output can live. Pick by where the comparison happens, not by compression ratio.
 *
 * {@link turboQuantizeToTypedArray} returns a plain `Int8Array` / `Int16Array` of finite
 * numbers, one per coordinate. That is exactly the shape every `IVectorStorage` backend in
 * this repo accepts, so it drops into any of them that declares a fixed-width column at
 * the output's length (mind that `padToPowerOf2` makes that length longer than the input's
 * — declare the column at the padded width).
 *
 * {@link turboQuantize}, {@link turboDequantize}, {@link turboQuantizedInnerProduct} and
 * {@link turboQuantizedCosineSimilarity} are an **in-process codec**. They are the
 * interesting half — sub-byte bit widths, 1-8 bits per dimension, with the angle
 * correction and the pairwise comparability checks — and **no storage backend in this repo
 * can accept their output**, nor could one without a new column type:
 *
 * - A {@link TurboQuantizeResult} is a record (`codes`, `bits`, `seed`, `norm`, `version`,
 *   `dimensions`, `paddedDimensions`), not an array of numbers.
 *   `assertVectorShape` — which every backend calls on write and on query — requires an
 *   array-like whose `length` equals the store's declared dimensionality and whose every
 *   entry is a finite number. A packed record fails on the first check; the packed
 *   `codes` buffer fails on the second, since at 4 bits it holds two coordinates per byte
 *   and its length is `ceil(paddedDimensions * bits / 8)`, not `dimensions`.
 * - The backends that score in-process (`InMemoryVectorStorage`, `SqliteVectorStorage`,
 *   `SqliteAiVectorStorage`) all call `cosineSimilarity(query, vector)` on raw numbers.
 *   There is no hook to substitute {@link turboQuantizedCosineSimilarity}, which is the
 *   only function that can read these codes.
 * - The pgvector-backed backends (`PostgresVectorStorage`, `SupabaseVectorStorage`)
 *   compute the distance **server-side** — a pgvector operator (`<=>`, `<->`, `<#>`) or
 *   an RPC. A client-side scorer cannot be injected into either at all.
 *
 * So use the packed record where the comparison happens in-process: an in-memory candidate
 * cache, or a client-side rerank over a shortlist retrieved by other means. **Do not
 * persist it expecting a retrieval path to exist** — there is none today, and building one
 * means a new column type plus a client-side scoring path plus per-backend fallbacks for
 * the server-side-distance engines. Tracked in
 * https://github.com/workglow-dev/libs/issues/798.
 *
 * ## Similarity shrinkage is corrected at 1-4 bits, documented at 5-8
 *
 * Magnitude is unbiased; the raw similarity is not. Clipping and rounding shrink the
 * reconstructed dot product relative to each side's `codeNorm`, so an uncorrected
 * {@link turboQuantizedCosineSimilarity} — and {@link turboQuantizedInnerProduct}, which
 * is that times the two norms — would systematically UNDER-report similar pairs. Mean
 * signed error against the exact cosine, 32 correlated pairs per cell, d=1024, seeded,
 * BEFORE the correction and as shipped:
 *
 * | bits | true 0.50       | true 0.80       | true 0.95       |
 * | ---- | --------------- | --------------- | --------------- |
 * | 1    | +0.002 → +0.002 | +0.001 → +0.001 | -0.000 → -0.000 |
 * | 2    | -0.056 → -0.001 | -0.080 → -0.001 | -0.075 → +0.001 |
 * | 3    | -0.017 → +0.001 | -0.027 → -0.001 | -0.028 → +0.001 |
 * | 4    | -0.005 → +0.000 | -0.007 → +0.001 | -0.009 → -0.000 |
 * | 5    | -0.002          | -0.003          | -0.003          |
 * | 6    | -0.000          | -0.001          | -0.001          |
 * | 7    | -0.000          | -0.000          | -0.000          |
 * | 8    | -0.000          | -0.000          | -0.000          |
 *
 * Every corrected cell collapses to the sampling floor of a 32-pair estimate, which is what
 * the arrows show: the residual is no longer a bias, it is noise.
 *
 * How: the ratio the estimator forms is `E[Q(x)Q(y)] / E[Q(x)^2]` for a standard bivariate
 * normal pair at the true cosine — a map that `quantizedCosine` inverts. At 1 bit that map
 * has a closed form, because a 2-level grid carries only sign and the ratio is
 * Goemans-Williamson's `(2/pi)*asin(rho)`. At 2-4 bits it has none, so it is evaluated by
 * quadrature and tabulated instead (see {@link invertShrinkage}); the two agree to four
 * decimals at 1 bit, which is what pins the quadrature. The map is DIMENSION-FREE — the
 * loading factor is divided by `sqrt(paddedLen)`, so the standardized grid is identical at
 * every d, and one table serves d=128 and d=4096 alike.
 *
 * 5-8 bits are deliberately left uncorrected: the residual bias is already at or below the
 * estimator's own noise there, and the table build cost scales as `levels^2`. See
 * {@link TURBO_MAX_CORRECTED_BITS}.
 *
 * THE COST IS VARIANCE NEAR ORTHOGONALITY. Inverting a map whose slope is below 1 amplifies
 * the estimator's noise by `1/g'(0)`, where that slope is shallowest: 1.57x at 1 bit, 1.13x
 * at 2, 1.04x at 3, 1.01x at 4. On i.i.d. uniform pairs at d=1024 — which concentrate at
 * cosine 0, the worst case for this — 2-bit RMSE goes 0.0130 → 0.0142. That is what takes
 * the 0.080 bias at rho = 0.8 down to 0.001, where RMSE falls 0.081 → 0.011. The noise is
 * symmetric and averages out over a candidate set, and it is worst precisely where the
 * answer is "unrelated" either way; the bias moved every absolute threshold in one
 * direction.
 *
 * RANKING IS UNCHANGED BY THE CORRECTION — the shrinkage is monotone in the true cosine and
 * so is its inverse, so applying it moves every score and moves none past another; turning
 * it on or off cannot reorder a candidate set. That is a statement about the CORRECTION,
 * not about how well the estimator's ordering matches the exact cosine's, which is a
 * separate, measured question — see the ordering bullet under Properties. ABSOLUTE
 * THRESHOLDS AND CALIBRATION are what this fixes: a 2-bit `cos > 0.8` cut (an ordinary RAG
 * threshold) used to drop pairs whose real cosine was 0.87.
 *
 * Properties:
 * - Data-oblivious: no training or codebook construction needed
 * - Per-vector: each vector quantized independently (streaming-friendly)
 * - The shrinkage correction is strictly monotone, so it never reorders a candidate set.
 *   Ordering fidelity against the EXACT cosine is a property of the quantizer, and is not
 *   perfect at the low widths. Measured over 500 documents at d=1024 (480 background, 10
 *   planted at true cosine 0.70-0.88, 10 near-misses at 0.30-0.48), seeded:
 *
 *   | bits | recall@10 | top-10 order identical | Kendall tau over the top 20 |
 *   | ---- | --------- | ---------------------- | --------------------------- |
 *   | 1    | 1.00      | no                     | 0.9368                      |
 *   | 2    | 1.00      | yes                    | 0.9789                      |
 *   | 4    | 1.00      | yes                    | 1.0000                      |
 *   | 8    | 1.00      | yes                    | 1.0000                      |
 *
 *   So retrieval of a shortlist is unaffected at every width — the planted set comes back
 *   whole even at 1 bit — while the ORDER within it is not: 1 bit transposes documents
 *   inside the top 10, and 2 bits reproduces the top 10 exactly but still transposes a
 *   pair further down. Rerank with exact vectors if the presented order matters at 1-2
 *   bits.
 */

import { TensorType } from "./Tensor";
import type { TypedArray } from "./TypedArray";

/**
 * Configuration for TurboQuant quantization.
 */
export interface TurboQuantizeOptions {
  /** Number of bits per dimension (1-8). Lower = more compression, higher distortion. */
  readonly bits: number | undefined;
  /** Seed for deterministic random rotation. If omitted, uses a fixed default seed. */
  readonly seed: number | undefined;
}

/**
 * Result of TurboQuant quantization, containing everything needed for dequantization.
 *
 * Two records are comparable only when their `(version, bits, seed, dimensions)` tuple
 * matches. `seed` selects the rotation basis, `bits` and `version` together fix the
 * reconstruction grid, and `dimensions` fixes the padding — mixing any of them yields
 * meaningless similarities. The pairwise helpers here enforce the last three; `version`
 * is enforced on every decode.
 */
export interface TurboQuantizeResult {
  /**
   * Encoding version. Bumped whenever the encoded codes to reconstructed values mapping
   * changes, so an older record fails loudly on decode instead of being silently
   * mis-scaled by a newer grid.
   */
  readonly version: number;
  /** Quantized codes packed into a Uint8Array */
  readonly codes: Uint8Array;
  /** Number of bits per dimension used */
  readonly bits: number;
  /** Original vector dimensionality */
  readonly dimensions: number;
  /**
   * Padded dimensionality used during rotation (next power of 2 >= dimensions).
   * The codes array covers this many coordinates; the extra coordinates beyond
   * `dimensions` are discarded during dequantization.
   */
  readonly paddedDimensions: number;
  /** The seed used for the random rotation (needed for dequantization) */
  readonly seed: number;
  /** L2 norm of the original vector (needed to reconstruct scale) */
  readonly norm: number;
}

/**
 * Rotation seed applied when a caller supplies none. Exported so a downstream default
 * (a task schema's `default`, a destructuring fallback) cites this constant rather than
 * repeating the literal, which would silently diverge if the default ever changed.
 */
export const DEFAULT_SEED = 42;

/**
 * Current {@link TurboQuantizeResult.version}. Bump whenever the mapping between stored
 * codes and reconstructed values changes (grid, loading factor, rotation, packing).
 */
const TURBO_QUANTIZE_VERSION = 1;

/**
 * Upper bound on the dimensionality this module will accept.
 *
 * Every entry point pads the input to `turboPaddedLength(dimensions)` and allocates several
 * `Float64Array`s of that length as working buffers, so peak cost is a multiple of the
 * padded length rather than the single buffer a naive estimate assumes: measured peak RSS
 * growth is 32 MB at d = 2^20, about 32 bytes per padded coordinate. 2^20 is already ~340x
 * the largest real embedding (3072-dim). Rejecting anything larger keeps a bogus or
 * hostile `dimensions` value from exhausting memory or spinning in the padding loop.
 */
const MAX_TURBO_DIMENSIONS = 2 ** 20;

/**
 * Inclusive bounds on a rotation seed: the int32 window {@link createPrng} actually
 * distinguishes. It coerces with `>>> 0` after an XOR, so anything outside this window
 * silently aliases onto another seed (`2**32 + 1` becomes `1`) and would decode against
 * a different rotation basis than it was encoded with.
 */
const MIN_SEED = -(2 ** 31);
const MAX_SEED = 2 ** 31 - 1;

/** Number of (sign-flip + Walsh-Hadamard) rounds applied by the randomized rotation. */
const SIGN_ROUNDS = 3;

/** Largest finite Float32 value; the ceiling on a norm {@link turboDequantize} can represent. */
const MAX_FLOAT32 = 3.4028234663852886e38;

/**
 * Validates a dimensionality before it is used to size any buffer.
 * @param n - Candidate dimensionality
 */
function assertDimensions(n: number): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`TurboQuant dimensions must be a positive integer, got ${n}`);
  }
  if (n > MAX_TURBO_DIMENSIONS) {
    throw new Error(
      `TurboQuant dimensions must be at most ${MAX_TURBO_DIMENSIONS}, got ${n} (the padded working buffers would exceed ~32 MB)`
    );
  }
}

/**
 * Validates a bit width before it is used to derive quantization levels.
 * @param bits - Candidate bits per dimension
 */
function assertBits(bits: number): void {
  if (!Number.isInteger(bits) || bits < 1 || bits > 8) {
    throw new Error(`TurboQuant bits must be an integer between 1 and 8, got ${bits}`);
  }
}

/**
 * Validates a rotation seed before it reaches the PRNG.
 *
 * Checked on encode as well as decode: a record written with a seed this module cannot
 * reproduce (a fraction, or a value outside the int32 window) is data that can never be
 * read back, and failing at write time is the only point where nothing has been lost yet.
 *
 * @param seed - Candidate rotation seed
 */
function assertSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < MIN_SEED || seed > MAX_SEED) {
    throw new Error(
      `TurboQuant seed must be an integer in the int32 range [${MIN_SEED}, ${MAX_SEED}], got ${seed}. ` +
        `Values outside that window alias onto a different seed once truncated to 32 bits.`
    );
  }
}

/**
 * Simple deterministic PRNG (xorshift32) for generating rotation seeds.
 * Produces deterministic sequences given a seed, suitable for reproducible rotations.
 *
 * Note: the seed is XOR-mixed with a constant before use so that every distinct
 * integer seed (including 0) maps to a distinct, non-zero initial PRNG state.
 */
function createPrng(seed: number): () => number {
  // XOR-mix the seed with the golden-ratio constant so that seed=0 does not
  // collapse to the same state as seed=1 (xorshift32 requires a non-zero state).
  // The `|| 1` guards the one theoretical edge-case where the XOR result is 0
  // (i.e. the caller passed seed = 0x616c8647).
  let state = (seed ^ 0x9e3779b9) >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    // Convert to [0, 1) range
    return (state >>> 0) / 4294967296;
  };
}

/**
 * Memory budget for memoized sign tables.
 *
 * An entry costs `SIGN_ROUNDS * paddedLen` bytes, so a count-only cap says nothing about
 * memory: 16 entries at the maximum dimensionality would retain hundreds of megabytes.
 * The byte total is the real bound; the count cap stays as a secondary limit so a stream
 * of tiny distinct seeds cannot accumulate unbounded Map overhead.
 */
const SIGN_TABLE_CACHE_MAX_BYTES = 8 * 1024 * 1024;

/** Secondary bound on memoized sign tables, in entries. */
const SIGN_TABLE_CACHE_MAX_ENTRIES = 16;

/** Memoized sign tables keyed by `${seed}:${paddedLen}` (insertion-ordered for eviction). */
const signTableCache = new Map<string, readonly Uint8Array[]>();

/** Running total of the bytes retained by {@link signTableCache}. */
let signTableCacheBytes = 0;

/** Total bytes held by one memoized sign table. */
function signTableBytes(table: readonly Uint8Array[]): number {
  let total = 0;
  for (const mask of table) total += mask.length;
  return total;
}

/**
 * Drops every memoized sign table.
 *
 * The cache is process-global and keyed by `(seed, paddedLen)`, so a long-lived host that
 * quantizes across many seeds or dimensionalities holds up to
 * {@link SIGN_TABLE_CACHE_MAX_BYTES} indefinitely. This releases it. Purely a memory
 * operation: tables are pure functions of their key, so clearing changes no result, only
 * the cost of recomputing one.
 */
export function clearSignTableCache(): void {
  signTableCache.clear();
  signTableCacheBytes = 0;
}

/**
 * Returns the `SIGN_ROUNDS` Rademacher flip masks for a (seed, paddedLen) pair.
 *
 * Each mask holds one byte per coordinate: `1` means "flip the sign". The draws
 * are made in exactly the order the forward rotation consumes them (round 0 for
 * every coordinate, then round 1, then round 2), so the forward and inverse
 * transforms see identical masks.
 *
 * The result is memoized because the inverse rotation would otherwise rebuild a
 * `SIGN_ROUNDS x paddedLen` table on every single dequantization.
 *
 * @param seed - Rotation seed
 * @param paddedLen - Padded (power-of-2) dimensionality
 * @returns One flip mask per rotation round. The returned arrays must not be mutated.
 */
function getSignTable(seed: number, paddedLen: number): readonly Uint8Array[] {
  const key = `${seed}:${paddedLen}`;
  const cached = signTableCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const prng = createPrng(seed);
  const table: Uint8Array[] = [];
  for (let round = 0; round < SIGN_ROUNDS; round++) {
    const mask = new Uint8Array(paddedLen);
    for (let i = 0; i < paddedLen; i++) {
      mask[i] = prng() < 0.5 ? 1 : 0;
    }
    table.push(mask);
  }

  // Evict oldest-first until the new entry fits both bounds. Map iteration is
  // insertion-ordered, so `keys().next()` is the oldest entry. A single table can never
  // exceed the byte budget on its own (SIGN_ROUNDS * MAX_TURBO_DIMENSIONS = 3 MB), so
  // this always terminates with room to spare.
  const entryBytes = signTableBytes(table);
  while (
    signTableCache.size > 0 &&
    (signTableCache.size >= SIGN_TABLE_CACHE_MAX_ENTRIES ||
      signTableCacheBytes + entryBytes > SIGN_TABLE_CACHE_MAX_BYTES)
  ) {
    const oldest = signTableCache.keys().next();
    if (oldest.done === true) break;
    const evicted = signTableCache.get(oldest.value);
    if (evicted !== undefined) signTableCacheBytes -= signTableBytes(evicted);
    signTableCache.delete(oldest.value);
  }

  signTableCache.set(key, table);
  signTableCacheBytes += entryBytes;
  return table;
}

/**
 * Applies a randomized rotation to a vector using the fast Walsh-Hadamard transform
 * combined with random sign flips. This is an approximation of a random orthogonal
 * rotation that runs in O(d log d) time instead of O(d²).
 *
 * The input is zero-padded to the next power of 2 before the transform. All
 * `paddedLen` coordinates are returned so that the transform is fully invertible.
 * Dropping the extra coordinates would break orthogonality for non-power-of-2
 * input dimensions.
 *
 * We apply 3 rounds of (sign-flip + WHT) for good isometry properties.
 */
function randomRotate(values: Float64Array, seed: number): Float64Array {
  const d = values.length;
  // Pad to next power of 2 for Hadamard transform
  const paddedLen = turboPaddedLength(d);
  const result = new Float64Array(paddedLen);
  result.set(values);

  const signs = getSignTable(seed, paddedLen);

  // Apply 3 rounds for good mixing (standard practice for randomized Hadamard)
  for (let round = 0; round < SIGN_ROUNDS; round++) {
    // Random sign flips (diagonal Rademacher matrix)
    const mask = signs[round];
    for (let i = 0; i < paddedLen; i++) {
      if (mask[i] === 1) {
        result[i] = -result[i];
      }
    }

    // Fast Walsh-Hadamard transform (in-place, normalized)
    fastWalshHadamard(result);
  }

  // Return ALL paddedLen coordinates to preserve full invertibility.
  return result;
}

/**
 * Inverse of randomRotate: undoes the rotation to reconstruct the original vector direction.
 * The input must be the full paddedLen array returned by randomRotate.
 */
function inverseRandomRotate(values: Float64Array, seed: number): Float64Array {
  const paddedLen = values.length;
  const result = new Float64Array(paddedLen);
  result.set(values);

  const signs = getSignTable(seed, paddedLen);

  // Apply rounds in reverse order
  for (let round = SIGN_ROUNDS - 1; round >= 0; round--) {
    // WHT is its own inverse (up to scaling, which we handle)
    fastWalshHadamard(result);

    // Undo sign flips
    const mask = signs[round];
    for (let i = 0; i < paddedLen; i++) {
      if (mask[i] === 1) {
        result[i] = -result[i];
      }
    }
  }

  return result;
}

/**
 * In-place Fast Walsh-Hadamard Transform with normalization.
 * Runs in O(n log n) where n must be a power of 2.
 *
 * The power-of-2 requirement is enforced rather than assumed: at a non-power-of-2
 * length the butterfly reads past the end of the buffer, silently producing NaN.
 */
function fastWalshHadamard(data: Float64Array): void {
  const n = data.length;
  if (n < 1 || (n & (n - 1)) !== 0) {
    throw new Error(`fastWalshHadamard requires a power-of-2 length, got ${n}`);
  }
  const norm = 1 / Math.sqrt(n);

  for (let halfSize = 1; halfSize < n; halfSize *= 2) {
    for (let i = 0; i < n; i += halfSize * 2) {
      for (let j = i; j < i + halfSize; j++) {
        const a = data[j];
        const b = data[j + halfSize];
        data[j] = a + b;
        data[j + halfSize] = a - b;
      }
    }
  }

  // Normalize
  for (let i = 0; i < n; i++) {
    data[i] *= norm;
  }
}

/**
 * Smallest power of 2 that is >= n.
 *
 * Doubling uses `*= 2` rather than `<<= 1`: the shift operators coerce to 32-bit
 * signed integers, so at p = 2^30 a shift wraps to -2147483648 and then to 0,
 * leaving `p < n` true forever.
 *
 * Exported because every caller that reasons about TurboQuant's padded width needs
 * exactly this function INCLUDING its {@link assertDimensions} guard. A local
 * reimplementation without that guard accepts a non-integer, a zero, or a length past
 * {@link MAX_TURBO_DIMENSIONS} and hands it on, so the caller's own carefully worded
 * validation is bypassed and the failure surfaces later as a low-level message.
 *
 * Named for TurboQuant rather than for the arithmetic because that guard makes it
 * TurboQuant-specific: it rejects anything above {@link MAX_TURBO_DIMENSIONS} (2^20) with
 * a message naming this module, so it is not the general-purpose next-power-of-2 helper a
 * neutral name would advertise.
 */
export function turboPaddedLength(n: number): number {
  assertDimensions(n);
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Outermost reconstruction level of the MSE-optimal uniform quantizer for a
 * unit-variance Gaussian, indexed by `bits - 1` (so `levels = 2^bits`).
 *
 * Derived from Max (1960), whose optimum-uniform step sizes are
 * `Δ = 1.596, 0.9957, 0.5860, 0.3352, 0.1881, 0.1041, 0.0568, 0.0308`; the outer level is
 * `(levels - 1) * Δ / 2`. That is exactly this module's parameterization, because
 * {@link dequantizeScalar} places `levels` equally spaced points spanning `[-scale, scale]`
 * — so `scale` IS the outer level.
 *
 * The clipping range has to widen with bit width. A range fixed at 3σ leaves a
 * bits-independent clipping error that dominates everything the extra levels buy: measured
 * relative L2 at d=1024 was identical (~0.035) at 6 and 8 bits, and at 1 bit the two
 * reconstruction points sat at ±3σ, inflating reconstructed magnitude 3x.
 */
const GAUSSIAN_LOADING_FACTORS = [
  0.7979, 1.4937, 2.0517, 2.5138, 2.9156, 3.2792, 3.6068, 3.927,
] as const;

/** Standard normal density. */
function gaussianPdf(x: number): number {
  return Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI);
}

/**
 * `∫₀^∞ u² · exp(-a·u - u²/2) du`, the clipping-error integral with the constant
 * `φ(a)` factored out analytically.
 *
 * Written this way on purpose. The closed form `(1 + a²)Q(a) - a·φ(a)` cancels catastrophically
 * once `a` reaches the far tail the 16-bit grid optimizes into (~6σ), where the two terms agree
 * to three digits and a tail approximation's absolute error dwarfs their difference. Factoring
 * `φ(a)` out leaves a smooth positive integrand that Simpson's rule resolves to full precision
 * at any `a`, and needs no error-function approximation.
 */
function clippingErrorIntegral(a: number): number {
  const upper = 12;
  const steps = 1200;
  const h = upper / steps;
  const term = (u: number): number => u * u * Math.exp(-a * u - (u * u) / 2);
  let sum = term(0) + term(upper);
  for (let i = 1; i < steps; i++) {
    sum += term(i * h) * (i % 2 === 1 ? 4 : 2);
  }
  return (sum * h) / 3;
}

/**
 * Mean squared error of a uniform quantizer with `levels` points spanning `[-a, a]`,
 * applied to a unit-variance Gaussian: uniform granular error plus clipping error.
 */
function quantizerDistortion(a: number, levels: number): number {
  const step = (2 * a) / (levels - 1);
  return (step * step) / 12 + 2 * gaussianPdf(a) * clippingErrorIntegral(a);
}

/** Memoized {@link optimalLoadingFactor} results for level counts outside the table. */
const loadingFactorCache = new Map<number, number>();

/**
 * Outermost reconstruction level of the MSE-optimal uniform quantizer for a unit-variance
 * Gaussian with `levels` levels.
 *
 * Power-of-two level counts up to 256 come from {@link GAUSSIAN_LOADING_FACTORS}. Anything
 * else is solved numerically by minimizing {@link quantizerDistortion} — needed by
 * {@link turboQuantizeToTypedArray}, whose effective level count is `2 * max + 1`
 * (255 for int8, 65535 for int16) and so is never in the table.
 *
 * The numeric solution converges onto the tabulated curve as the grid gets finer, and is
 * loosest at the coarse end where the distortion minimum is shallowest:
 *
 * | levels | 2    | 4    | 8    | 16   | 32   | 64   | 128  | 256  |
 * | ------ | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |
 * | dev    | 4.03%| 1.64%| 0.86%| 0.35%| 0.14%| 0.00%| 0.13%| 0.12%|
 *
 * The 4% at 2 levels does not matter, because the solver is never consulted there. Its
 * only callers are the int8 and int16 typed-array paths, at 255 and 65535 levels — past
 * the fine end of the table, where the two methods have already agreed to ~0.1% for four
 * consecutive doublings. The tabulated widths (1-8 bits) never reach the solver at all.
 */
function optimalLoadingFactor(levels: number): number {
  if (!Number.isInteger(levels) || levels < 2) {
    throw new Error(`TurboQuant requires at least 2 quantization levels, got ${levels}`);
  }
  const bitsIndex = Math.log2(levels);
  if (
    Number.isInteger(bitsIndex) &&
    bitsIndex >= 1 &&
    bitsIndex <= GAUSSIAN_LOADING_FACTORS.length
  ) {
    return GAUSSIAN_LOADING_FACTORS[bitsIndex - 1];
  }

  const cached = loadingFactorCache.get(levels);
  if (cached !== undefined) return cached;

  // Ternary search: distortion is unimodal in `a` (granular error rises with it, clipping
  // error falls). 80 iterations shrink the bracket well past double precision.
  let low = 0.2;
  let high = 20;
  for (let i = 0; i < 80; i++) {
    const leftThird = low + (high - low) / 3;
    const rightThird = high - (high - low) / 3;
    if (quantizerDistortion(leftThird, levels) < quantizerDistortion(rightThird, levels)) {
      high = rightThird;
    } else {
      low = leftThird;
    }
  }
  const solved = (low + high) / 2;
  loadingFactorCache.set(levels, solved);
  return solved;
}

/**
 * Returns quantization parameters for uniform scalar quantization over the range
 * [-scale, scale].
 *
 * After random rotation in paddedLen-dimensional space, each coordinate of a
 * d-dimensional unit vector (zero-padded to paddedLen) has variance 1/paddedLen, so the
 * clipping boundary is the MSE-optimal loading factor for that bit width, in units of the
 * per-coordinate standard deviation. No non-uniform or distribution-fitted quantization is
 * performed — the levels are equally spaced.
 */
function getQuantizationParams(
  bits: number,
  paddedLen: number
): { readonly levels: number; readonly scale: number } {
  const levels = 1 << bits; // 2^bits quantization levels
  const scale = optimalLoadingFactor(levels) / Math.sqrt(paddedLen);
  return { levels, scale };
}

/**
 * Highest bit width whose cosine shrinkage is corrected by {@link invertShrinkage}.
 *
 * Four, for two independent reasons that happen to agree.
 *
 * Accuracy: at 5 bits the residual signed bias is 0.0030 (d=1024, rho=0.8), already below
 * the estimator's OWN RMSE of 0.0034 in that same cell — the correction would be moving a
 * number by less than the noise it carries, which buys nothing and still pays the
 * near-orthogonal variance amplification.
 *
 * Cost: {@link shrinkageTable} is O(levels^2) — one conditional expectation per Simpson
 * node costs a CDF per decision edge, and there are `levels` bins each holding nodes. The
 * measured cold build is 16/21/22 ms at 2/3/4 bits, 56 ms at 5, 84 ms at 6 and 555 ms at
 * 8. Paying half a second on the first 8-bit comparison to correct a bias of 0.0001 is not
 * a trade worth offering.
 *
 * EXPORTED because it is a boundary a caller has to act on, not just read about: at or
 * below it, {@link turboDequantize} plus a plain `cosineSimilarity` returns the
 * UNCORRECTED estimator and disagrees with {@link turboQuantizedCosineSimilarity}; above
 * it the two routes are interchangeable. A caller integrating with a scorer that takes
 * raw vectors needs to branch on that, and reading a docstring and hoping is not a branch.
 */
export const TURBO_MAX_CORRECTED_BITS = 4;

/** Internal alias for {@link TURBO_MAX_CORRECTED_BITS}; one literal, two names. */
const MAX_CORRECTED_BITS = TURBO_MAX_CORRECTED_BITS;

/**
 * Standard normal CDF; the only special function the shrinkage map needs.
 *
 * Zelen & Severo's rational approximation (Abramowitz & Stegun 26.2.17), whose absolute
 * error is bounded by 7.5e-8. That is three orders of magnitude below the 1.2e-4 the
 * table's own linear interpolation contributes, so a higher-precision `erf` would sharpen
 * nothing measurable while costing a series evaluation per call — and this is called
 * `levels` times per quadrature node.
 */
function standardNormalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const density = Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI);
  const tail =
    density *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}

/**
 * Integration limit for the two unbounded outer quantization bins, in standard deviations.
 * `phi(9)` is ~1e-18, so the truncated mass is far below double precision's reach on a
 * quantity of order 1.
 */
const SHRINKAGE_QUADRATURE_TAIL = 9;

/** Simpson nodes per unit of `x`, so a wide outer bin gets proportionally more of them. */
const SHRINKAGE_NODES_PER_UNIT = 16;

/**
 * `E[Q(x)Q(y)] / E[Q(x)^2]` for the standardized grid at this bit width, where `(x, y)` is
 * a standard bivariate normal pair with correlation `rho` and `Q` is this module's uniform
 * quantizer expressed in units of the per-coordinate standard deviation.
 *
 * This IS the quantity the estimator returns. {@link quantizedCosine} divides the code dot
 * product by both `codeNorm`s, which estimates exactly this ratio; and the map is
 * DIMENSION-FREE, because {@link getQuantizationParams} divides the loading factor by
 * `sqrt(paddedLen)` — the same factor by which a rotated coordinate's standard deviation
 * shrinks. The standardized grid is therefore identical at every dimensionality, and one
 * table serves d=128 and d=4096 alike. (Measured: across a 32x range of d the ratio moves
 * by at most 1.2%, while within one d it moves 4.5% with `rho`.)
 *
 * Evaluated as `E_x[Q(x) * E[Q(y)|x]]`. The inner conditional expectation is a sum of
 * normal CDFs — smooth in `x`, unlike `Q` itself — so the only discontinuities left are
 * the bin edges, which the outer sum splits on. Simpson within each bin then resolves it:
 * the integrand is smooth there and the result is converged to four decimals by
 * {@link SHRINKAGE_NODES_PER_UNIT} = 8, half what is used.
 *
 * At 1 bit this reduces to the closed form the module already inverts. A 2-level grid puts
 * its single decision edge at zero with reconstruction points at `±outer`, so
 * `E[Q(x)Q(y)] = outer^2 * E[sign(x)sign(y)]` and `E[Q^2] = outer^2`, leaving
 * `(2/pi)*asin(rho)` — Goemans-Williamson. That the quadrature reproduces it to four
 * decimals is the one exact reference this machinery has.
 */
function shrinkageAt(bits: number, rho: number): number {
  const levels = 1 << bits;
  const outer = optimalLoadingFactor(levels);
  const step = (2 * outer) / (levels - 1);
  // `y | x ~ N(rho*x, 1 - rho^2)`. The floor keeps `rho = 1` from dividing by zero; at
  // that width the CDF arguments saturate to 0/1 and the conditional collapses to `Q(x)`,
  // which is the correct limit.
  const conditionalSd = Math.sqrt(Math.max(1 - rho * rho, 1e-12));

  // `E[Q(y)|x]` by summation by parts over the `levels - 1` decision edges: the levels are
  // equally spaced, so every jump is the same `step` and the sum needs one CDF per edge
  // rather than one per level pair.
  const conditionalMean = (x: number): number => {
    const mean = rho * x;
    let acc = -outer;
    for (let j = 0; j < levels - 1; j++) {
      const edge = -outer + (j + 0.5) * step;
      acc += step * (1 - standardNormalCdf((edge - mean) / conditionalSd));
    }
    return acc;
  };

  let cross = 0;
  let square = 0;
  for (let k = 0; k < levels; k++) {
    const point = -outer + k * step;
    const lo = k === 0 ? -SHRINKAGE_QUADRATURE_TAIL : -outer + (k - 0.5) * step;
    const hi = k === levels - 1 ? SHRINKAGE_QUADRATURE_TAIL : -outer + (k + 0.5) * step;
    if (hi <= lo) continue;

    square += point * point * (standardNormalCdf(hi) - standardNormalCdf(lo));

    let nodes = Math.max(4, Math.ceil((hi - lo) * SHRINKAGE_NODES_PER_UNIT));
    if (nodes % 2 === 1) nodes++;
    const h = (hi - lo) / nodes;
    let sum = 0;
    for (let i = 0; i <= nodes; i++) {
      const x = lo + i * h;
      const weight = i === 0 || i === nodes ? 1 : i % 2 === 1 ? 4 : 2;
      sum += weight * conditionalMean(x) * gaussianPdf(x);
    }
    cross += point * ((sum * h) / 3);
  }

  return square === 0 ? 0 : cross / square;
}

/** Knot count of each shrinkage table. Odd so a knot lands exactly on `rho = 0.5`. */
const SHRINKAGE_TABLE_POINTS = 65;

/** Lazily built shrinkage tables, memoized per bit width. */
const shrinkageTableCache = new Map<number, ShrinkageTable>();

interface ShrinkageTable {
  readonly rho: Float64Array;
  readonly g: Float64Array;
}

/**
 * The {@link shrinkageAt} map sampled at {@link SHRINKAGE_TABLE_POINTS} knots, built once
 * per bit width on first use and memoized for the life of the process.
 *
 * Lazy because the build is not free — 16 ms at 2 bits, 21 at 3, 22 at 4 — and a caller
 * that never compares at a corrected width should never pay for one. It is a pure function
 * of `bits`, so the memo is safe to hold forever; the whole cache is three Float64Arrays of
 * 65 doubles even if every corrected width is exercised.
 *
 * KNOTS ARE SPACED UNIFORMLY IN ANGLE (`rho_i = sin(pi*u/2)`), not in `rho`. The map is
 * steep and sharply curved as `rho` approaches 1 — where the inverse has to be most
 * precise, since that is the region an absolute threshold cuts on — and uniform-in-`rho`
 * knots resolve it worst exactly there. Measured worst-case round-trip
 * `|invert(g(rho)) - rho|` over `rho` in [0, 1]: 2.7e-3 with uniform knots, 8.0e-5 with
 * these. Same knot count, same build cost, 30x tighter; and the 1-bit map is exactly linear
 * in this parameterization, which is what lets the closed-form agreement check be sharp.
 */
function shrinkageTable(bits: number): ShrinkageTable {
  const cached = shrinkageTableCache.get(bits);
  if (cached !== undefined) return cached;

  const rho = new Float64Array(SHRINKAGE_TABLE_POINTS);
  const g = new Float64Array(SHRINKAGE_TABLE_POINTS);
  for (let i = 0; i < SHRINKAGE_TABLE_POINTS; i++) {
    const u = i / (SHRINKAGE_TABLE_POINTS - 1);
    rho[i] = Math.sin((Math.PI * u) / 2);
    g[i] = shrinkageAt(bits, rho[i]!);
  }
  const table: ShrinkageTable = { rho, g };
  shrinkageTableCache.set(bits, table);
  return table;
}

/**
 * Inverse of the shrinkage map: takes the raw ratio {@link quantizedCosine} computes and
 * returns the cosine that would produce it.
 *
 * Binary search over the tabulated `g` values plus linear interpolation. `g` is strictly
 * increasing in `rho` (a monotone-likelihood-ratio consequence of the bivariate normal),
 * so the search is well defined; and `g` is ODD in `rho`, because negating one side of the
 * pair negates every `Q(y)`, so only the non-negative half is tabulated and the sign is
 * reapplied.
 *
 * Exposed rather than kept private because the 1-bit case is the one point where this
 * machinery has an exact independent reference — `invertShrinkage(1, r)` must reproduce
 * `cos(pi*(1 - r)/2)`, the Goemans-Williamson inverse this module already ships — and that
 * check is the strongest available evidence that the quadrature behind it is right.
 *
 * @param bits - Bit width whose grid produced the estimate
 * @param estimate - Raw normalized code dot product, in [-1, 1]
 * @returns The corrected cosine, in [-1, 1]
 */
export function invertShrinkage(bits: number, estimate: number): number {
  assertBits(bits);
  const sign = estimate < 0 ? -1 : 1;
  const target = Math.min(1, Math.abs(estimate));
  const { rho, g } = shrinkageTable(bits);
  const last = g.length - 1;
  // A ratio at or past the endpoints has no bracket to interpolate inside. `g(0) = 0` and
  // `g(1) = 1`, so these are the exact answers rather than a clamp that loses information.
  if (target <= g[0]!) return 0;
  if (target >= g[last]!) return sign;

  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (g[mid]! <= target) lo = mid;
    else hi = mid;
  }
  const span = g[hi]! - g[lo]!;
  const fraction = span === 0 ? 0 : (target - g[lo]!) / span;
  return sign * (rho[lo]! + fraction * (rho[hi]! - rho[lo]!));
}

/**
 * Normalizes a vector to unit length, returning both the unit-length coordinates
 * and the original L2 norm.
 *
 * The sum of squares is accumulated on coordinates divided by the largest absolute
 * coordinate rather than on the raw ones. Accumulating `v * v` directly squares the
 * input's exponent, so the running sum leaves the double range long before the vector
 * itself does: it overflows to Infinity above ~1e154 (a finite input then reported as
 * "NaN or Infinity") and underflows to 0 below ~1e-162 (a finite input then reported as
 * a zero vector, decoding to all zeroes and scoring 0 against itself). Max-scaling keeps
 * every squared term in [0, 1], so the sum stays finite and non-zero for any finite input.
 *
 * The per-element `Number.isFinite` check is load-bearing under max-scaling, not
 * belt-and-braces: an Infinity input would otherwise set `maxAbs = Infinity` and every
 * scaled coordinate would become `Inf / Inf = NaN`, which no later check catches.
 *
 * The final division is by `maxAbs` and then by `rootS`, never by their product: for a
 * subnormal input the product is what underflows, while each factor separately is
 * representable and the two divisions reconstruct the unit direction exactly.
 *
 * A zero vector is not an error — it yields an all-zero `values` buffer and a
 * norm of 0.
 *
 * `norm` can still be `Infinity` for a FINITE input: max-scaling keeps the accumulator in
 * range, but the reconstruction `maxAbs * rootS` overflows once the true L2 norm exceeds
 * `Number.MAX_VALUE`. `values` is exact in that case, so the direction is intact and the
 * norm-free encoder is unaffected; only a caller that keeps `norm` has a problem, and it
 * is that caller's entry point ({@link turboQuantize}) that rejects it.
 *
 * `maxAbs` is returned so such a caller can report the coordinate magnitude that produced
 * the overflow rather than only the `Infinity` it became.
 */
function normalizeToUnit(vector: TypedArray): {
  readonly values: Float64Array;
  readonly norm: number;
  readonly maxAbs: number;
} {
  const d = vector.length;
  let maxAbs = 0;
  for (let i = 0; i < d; i++) {
    const value = vector[i];
    if (!Number.isFinite(value)) {
      throw new Error("Cannot quantize a vector containing NaN or Infinity");
    }
    const abs = Math.abs(value);
    if (abs > maxAbs) maxAbs = abs;
  }

  const values = new Float64Array(d);
  if (maxAbs === 0) {
    return { values, norm: 0, maxAbs };
  }

  let sumSquares = 0;
  for (let i = 0; i < d; i++) {
    const scaled = vector[i] / maxAbs;
    sumSquares += scaled * scaled;
  }
  const rootS = Math.sqrt(sumSquares);
  for (let i = 0; i < d; i++) {
    values[i] = vector[i] / maxAbs / rootS;
  }
  return { values, norm: maxAbs * rootS, maxAbs };
}

/**
 * Quantizes a single float value to an integer code in [0, levels-1].
 */
function quantizeScalar(value: number, scale: number, levels: number): number {
  // Map from [-scale, scale] to [0, 1]
  const normalized = (value + scale) / (2 * scale);
  // Clamp and discretize
  const clamped = Math.max(0, Math.min(1, normalized));
  const code = Math.round(clamped * (levels - 1));
  return code;
}

/**
 * Dequantizes an integer code back to a float value (reconstruction point).
 */
function dequantizeScalar(code: number, scale: number, levels: number): number {
  const normalized = code / (levels - 1);
  return normalized * 2 * scale - scale;
}

/**
 * Packs an array of codes (each in [0, 2^bits - 1]) into a compact Uint8Array.
 * For sub-byte bit widths, multiple codes share a byte.
 */
function packCodes(codes: number[], bits: number): Uint8Array {
  const totalBits = codes.length * bits;
  const numBytes = Math.ceil(totalBits / 8);
  const packed = new Uint8Array(numBytes);

  let bitPos = 0;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    // Write `bits` bits starting at bitPos
    let remaining = bits;
    let value = code;
    while (remaining > 0) {
      const byteIdx = bitPos >> 3;
      const bitOffset = bitPos & 7;
      const bitsToWrite = Math.min(remaining, 8 - bitOffset);
      const mask = (1 << bitsToWrite) - 1;
      packed[byteIdx] |= (value & mask) << bitOffset;
      value >>= bitsToWrite;
      bitPos += bitsToWrite;
      remaining -= bitsToWrite;
    }
  }

  return packed;
}

/**
 * Unpacks codes from a compact Uint8Array back to a Uint8Array of integers.
 * Bit widths are capped at 8, so every code fits in one byte; returning a
 * typed array keeps the per-comparison hot path free of boxed `number[]`
 * allocations.
 *
 * Throws if the buffer is not a Uint8Array, or is too small for the requested count and
 * bit width.
 */
function unpackCodes(packed: Uint8Array, bits: number, count: number): Uint8Array {
  const expectedBytes = Math.ceil((count * bits) / 8);
  // Checked before the length comparison: a non-array `packed` has an `undefined` length,
  // and `undefined < N` is false, so a size check alone waves it through and every byte
  // read yields `undefined -> NaN -> code 0`.
  if (!(packed instanceof Uint8Array)) {
    throw new Error(
      `unpackCodes: codes must be a Uint8Array, got ${Object.prototype.toString.call(packed)}`
    );
  }
  if (packed.length < expectedBytes) {
    throw new Error(
      `unpackCodes: buffer too small - need ${expectedBytes} bytes for ${count} codes at ${bits} bits, got ${packed.length}`
    );
  }
  const codes = new Uint8Array(count);

  let bitPos = 0;
  for (let i = 0; i < count; i++) {
    let code = 0;
    let remaining = bits;
    let shift = 0;
    while (remaining > 0) {
      const byteIdx = bitPos >> 3;
      const bitOffset = bitPos & 7;
      const bitsToRead = Math.min(remaining, 8 - bitOffset);
      const mask = (1 << bitsToRead) - 1;
      code |= ((packed[byteIdx] >> bitOffset) & mask) << shift;
      shift += bitsToRead;
      bitPos += bitsToRead;
      remaining -= bitsToRead;
    }
    codes[i] = code;
  }

  return codes;
}

/**
 * Quantizes a vector using the TurboQuant algorithm.
 *
 * Steps:
 * 1. Normalize the vector and record its L2 norm
 * 2. Apply randomized rotation (sign flips + Walsh-Hadamard transform)
 * 3. Quantize each rotated coordinate on a uniform grid whose clipping range is the
 *    MSE-optimal loading factor for this bit width
 * 4. Pack the codes into a compact bit representation
 *
 * @param vector - Input vector (any TypedArray). Must not contain NaN or Infinity.
 * @param options - Quantization options (bits per dimension, optional seed)
 * @returns Compact quantized representation
 */
export function turboQuantize(
  vector: TypedArray,
  options: TurboQuantizeOptions | undefined
): TurboQuantizeResult {
  const bits = options?.bits ?? 4;
  const seed = options?.seed ?? DEFAULT_SEED;

  assertBits(bits);
  assertSeed(seed);

  const d = vector.length;
  if (d === 0) {
    throw new Error("Cannot quantize an empty vector");
  }
  assertDimensions(d);

  // Step 1: Compute norm and normalize
  const { values, norm, maxAbs } = normalizeToUnit(vector);
  // A finite input can still have a norm no double holds: `normalizeToUnit` keeps the
  // accumulator in range, but the reconstruction `maxAbs * rootS` overflows above
  // Number.MAX_VALUE. Rejected here rather than returned, because every read path
  // (`turboDequantize`, both similarity helpers) checks `norm` and throws on the record
  // this would otherwise produce — a write that can never be read back.
  if (!Number.isFinite(norm)) {
    throw new Error(
      `TurboQuant cannot encode this vector: its true L2 norm is not representable as a double ` +
        `(largest absolute coordinate ${maxAbs}, norm overflows to ${norm}), and the record's ` +
        `\`norm\` field is what every read path rescales by. Prescale the input — cosine ` +
        `similarity is scale-free, so dividing every coordinate by a constant changes no ` +
        `similarity — or use turboQuantizeToTypedArray, which records no norm and handles this ` +
        `input unchanged.`
    );
  }

  // Step 2: Random rotation — returns all paddedLen coordinates
  const paddedLen = turboPaddedLength(d);
  const rotated = randomRotate(values, seed);

  // Step 3: Scalar quantization per coordinate (all paddedLen)
  const { levels, scale } = getQuantizationParams(bits, paddedLen);
  const codes: number[] = new Array(paddedLen);
  for (let i = 0; i < paddedLen; i++) {
    codes[i] = quantizeScalar(rotated[i], scale, levels);
  }

  // Step 4: Pack into compact representation
  const packed = packCodes(codes, bits);

  const result: TurboQuantizeResult = {
    version: TURBO_QUANTIZE_VERSION,
    codes: packed,
    bits,
    dimensions: d,
    paddedDimensions: paddedLen,
    seed,
    norm,
  };
  // The structural half of the same guarantee: every record this module hands out passes
  // the check every reader applies. Today that holds only by coincidence — the encoder and
  // `assertQuantizeResultShape` are two independent statements of the same invariant — and
  // the check is O(1) on already-computed scalars, so asserting it costs nothing.
  assertQuantizeResultShape(result);
  return result;
}

/**
 * Validates the scalar fields of a {@link TurboQuantizeResult}.
 *
 * `TurboQuantizeResult` is a plain, serializable interface intended for storage,
 * so a value reaching the decode path may have been persisted, hand-built, or
 * mismatched with a different record. Every field that sizes a buffer or drives
 * the transform is therefore re-checked rather than trusted.
 */
function assertQuantizeResultShape(quantized: TurboQuantizeResult): void {
  const { version, codes, bits, dimensions, paddedDimensions, seed, norm } = quantized;
  // First, before any length or range check: a record that has been through JSON (or any
  // structured-clone-free channel) carries `codes` as a plain object — `{"type":"Buffer",
  // "data":[...]}` from a Node Buffer, `{"0":..,"1":..}` from a Uint8Array. Neither has a
  // usable `length`, so every downstream size guard passes and the decode silently yields
  // a vector of zeroes instead of failing.
  if (!(codes instanceof Uint8Array)) {
    throw new Error(
      `TurboQuant codes must be a Uint8Array, got ${Object.prototype.toString.call(codes)}. ` +
        `A record restored from JSON must have its codes rebuilt (e.g. Uint8Array.from(...)) before decoding.`
    );
  }
  if (version !== TURBO_QUANTIZE_VERSION) {
    throw new Error(
      `TurboQuant record version ${version} is not supported by this build (expected ${TURBO_QUANTIZE_VERSION})`
    );
  }
  assertBits(bits);
  assertDimensions(dimensions);
  assertSeed(seed);
  // A negative norm is corrupt, not merely odd: `norm` is always a `Math.sqrt` result, and
  // the decode rescale multiplies by it, so a negative one sign-flips every reconstructed
  // coordinate — a vector that scores -1 against its own source with nothing reported.
  if (!Number.isFinite(norm) || norm < 0) {
    throw new Error(`TurboQuant norm must be a finite, non-negative number, got ${norm}`);
  }
  const expectedPadded = turboPaddedLength(dimensions);
  if (paddedDimensions !== expectedPadded) {
    throw new Error(
      `TurboQuant paddedDimensions must be turboPaddedLength(dimensions) = ${expectedPadded}, got ${paddedDimensions}`
    );
  }
}

/**
 * Reconstructs the rotated-domain coordinates from a record's packed codes.
 *
 * Returns the L2 norm of those coordinates alongside them because every consumer needs it:
 * clipping and rounding do not preserve magnitude, so the reconstruction has to be
 * renormalized before it means anything. Shared by the decode and both similarity helpers
 * so all three sit on one definition of "the vector these codes stand for".
 *
 * @param quantized - A record whose shape has already been validated
 */
function reconstructRotatedCodes(quantized: TurboQuantizeResult): {
  readonly values: Float64Array;
  readonly codeNorm: number;
} {
  const { codes, bits, paddedDimensions } = quantized;
  const unpacked = unpackCodes(codes, bits, paddedDimensions);
  const { levels, scale } = getQuantizationParams(bits, paddedDimensions);

  const values = new Float64Array(paddedDimensions);
  let sumSquares = 0;
  for (let i = 0; i < paddedDimensions; i++) {
    const value = dequantizeScalar(unpacked[i], scale, levels);
    values[i] = value;
    sumSquares += value * value;
  }
  return { values, codeNorm: Math.sqrt(sumSquares) };
}

/**
 * Dequantizes a TurboQuant result back to a Float32Array.
 *
 * Steps:
 * 1. Unpack the codes and reconstruct the rotated coordinates
 * 2. Apply inverse rotation
 * 3. Crop to the original dimensions and renormalize to the recorded norm
 *
 * The final step is a rescale, not a multiply. Quantization does not preserve magnitude —
 * at low bit widths the clipped grid inflates it badly — and `norm` is the one quantity the
 * encoder stored exactly, so restoring it costs nothing and removes the bias.
 *
 * A record whose norm exceeds the Float32 range is rejected rather than decoded. The output
 * is a Float32Array whose L2 norm IS `norm`, so an out-of-range norm cannot be represented
 * and every coordinate would come back as Infinity with nothing reported. The check is on
 * the recorded scalar, so it costs O(1) and needs no scan of the result. Only the decode is
 * affected: cosine similarity is scale-free, so such a record stays fully comparable through
 * {@link turboQuantizedCosineSimilarity}.
 *
 * ## THE OUTPUT IS NOT SHRINKAGE-CORRECTED AT 1-4 BITS
 *
 * These are decoded coordinates, and comparing two of them with a plain `cosineSimilarity`
 * gives the RAW estimator — the one the correction exists to undo. At 1 bit that reads a
 * true 0.80 as 0.59; at 2-4 bits it is low by less, but low in the same direction and for
 * the same reason. The corrected number comes from {@link turboQuantizedCosineSimilarity},
 * or from {@link turboPrepareQuery} + {@link turboPreparedCosineSimilarity} in a search
 * loop. At 5-8 bits the shrinkage is left uncorrected by design, so there the two routes
 * ARE interchangeable; that boundary is {@link TURBO_MAX_CORRECTED_BITS}. Pinned by the
 * test "turboDequantize + plain cosineSimilarity is NOT shrinkage-corrected at 1-4 bits".
 *
 * The warning lives here, and not only on {@link turboPrepareQuery}, because this is the
 * function on the natural integration path: a `Float32Array` is the only output shape an
 * `IVectorStorage` backend accepts, so a caller wiring turbo into storage reaches this
 * one — and reaches the prepared-query docs only if they already understood the problem.
 *
 * THERE IS DELIBERATELY NO "corrected-compare" HELPER, because it would be a rename. The
 * correction inverts a map defined on the CODE-DOMAIN ratio `dot / (codeNormA *
 * codeNormB)`, and this function has already renormalized its output to the recorded
 * `norm`, destroying that ratio. So any helper taking two {@link TurboQuantizeResult}s and
 * returning a corrected number IS {@link turboQuantizedCosineSimilarity}. The case that
 * genuinely needs one — an `IVectorStorage` backend scoring decoded vectors server-side,
 * with no hook to substitute a scorer — is not fixable in this module at all, and is
 * tracked in https://github.com/workglow-dev/libs/issues/798 (see the module doc). No
 * workaround exists for it today.
 *
 * @param quantized - The TurboQuant quantization result
 * @returns Reconstructed vector as Float32Array
 */
export function turboDequantize(quantized: TurboQuantizeResult): Float32Array {
  assertQuantizeResultShape(quantized);
  const { dimensions, seed, norm } = quantized;
  if (norm > MAX_FLOAT32) {
    throw new Error(
      `TurboQuant cannot dequantize a record whose norm ${norm} exceeds the Float32 range ` +
        `(max ${MAX_FLOAT32}): the reconstruction is a Float32Array with that L2 norm, so every ` +
        `coordinate would overflow to Infinity. Cosine similarity is scale-free and still works ` +
        `on this record.`
    );
  }

  const result = new Float32Array(dimensions);
  // A zero vector has no direction to restore. The early return is also what keeps the
  // rescale below safe: for an even `levels` count no reconstruction point sits at exactly
  // zero, so a zero input decodes to a small non-zero vector that renormalizing would
  // amplify to full length.
  if (norm === 0) return result;

  const { values } = reconstructRotatedCodes(quantized);
  const unrotated = inverseRandomRotate(values, seed);

  // Renormalize against the CROPPED coordinates: those are the output, and for a
  // non-power-of-2 dimensionality their norm differs from the padded one.
  let sumSquares = 0;
  for (let i = 0; i < dimensions; i++) {
    sumSquares += unrotated[i] * unrotated[i];
  }
  const croppedNorm = Math.sqrt(sumSquares);
  if (croppedNorm === 0) return result;

  const rescale = norm / croppedNorm;
  for (let i = 0; i < dimensions; i++) {
    result[i] = unrotated[i] * rescale;
  }

  return result;
}

/**
 * Estimates the inner product between two TurboQuant-quantized vectors without full
 * dequantization: it skips the inverse rotation and the crop, working in the rotated
 * domain where the codes already live. For maximum accuracy, dequantize both sides and
 * take a real dot product.
 *
 * IT DOES NOT SKIP THE DECODE, and the docstring that stood here implied otherwise. Both
 * sides are unpacked and reconstructed on EVERY call — four fresh arrays per comparison —
 * so scoring one query against a candidate set re-decodes that query once per candidate.
 * At d=1024 and 20,000 candidates that is 80,000 arrays and ~352 MB of churn, roughly
 * half of it re-deriving coordinates that never changed.
 *
 * A SEARCH LOOP SHOULD USE {@link turboPrepareQuery} instead — decode the query once, then
 * {@link turboPreparedCosineSimilarity} per candidate. Measured on that sweep: 230 ms ->
 * 105 ms at 8 bits (2.1x) and 180 ms -> 110 ms at 4 bits (1.6x). The corrected widths gain
 * less because {@link finishCosine}'s table inversion is a per-CANDIDATE cost that neither
 * path can hoist; what the prepared form removes is the per-candidate query decode, and
 * nothing else. This helper stays the right shape for a one-off comparison, where preparing
 * a query would be the same work spelled longer.
 *
 * @param a - First quantized vector
 * @param b - Second quantized vector
 * @returns Estimated inner product
 */
export function turboQuantizedInnerProduct(a: TurboQuantizeResult, b: TurboQuantizeResult): number {
  assertComparablePair(a, b);
  return quantizedCosine(a, b) * a.norm * b.norm;
}

/**
 * Validates that two records were produced by compatible encodings and are individually
 * well-formed. The pairwise checks come first so a mismatch reports the mismatch rather
 * than whichever record happens to be inspected first.
 */
function assertComparablePair(a: TurboQuantizeResult, b: TurboQuantizeResult): void {
  if (a.dimensions !== b.dimensions) {
    throw new Error("Vectors must have the same dimensions");
  }
  if (a.bits !== b.bits) {
    throw new Error("Vectors must use the same bit width");
  }
  if (a.seed !== b.seed) {
    throw new Error("Vectors must use the same rotation seed");
  }
  assertQuantizeResultShape(a);
  assertQuantizeResultShape(b);
}

/**
 * Cosine similarity between the two reconstructions, computed in the rotated domain.
 *
 * The rotation is orthogonal, so it preserves both inner products and norms and the
 * rotated-domain cosine IS the original-domain cosine. Dividing by each reconstruction's
 * own norm — rather than treating the codes as if they were already unit vectors — is what
 * makes the result an actual cosine: Cauchy-Schwarz then bounds it to [-1, 1] by
 * construction and a record compared with itself scores exactly 1. The clamp only absorbs
 * floating-point rounding at the endpoints.
 *
 * At 1 BIT that ratio is not an estimate of the cosine at all, and the last line corrects
 * for it. A 2-level grid is exactly ±scale, so both reconstructions are constant-magnitude
 * sign vectors: the normalized dot product reduces to the fraction of coordinates whose
 * signs agree, mapped to [-1, 1]. For a random rotation that statistic converges to
 * `1 - 2*theta/pi` (Goemans-Williamson), a DIFFERENT function of the angle rather than a
 * noisy cosine — it reads a true 0.80 as 0.59 and a true 0.95 as 0.79. It is also exactly
 * invertible, and the inversion costs one `Math.cos` per comparison, changes no stored
 * bytes, and needs no version bump: `theta = pi*(1 - ratio)/2`, so `cos(theta)` recovers
 * the cosine.
 *
 * At 2-4 BITS the same correction applies, by the same argument, and the last line applies
 * it through {@link invertShrinkage}. The shrinkage there is ordinary quantization error —
 * clipping and rounding shrink the reconstructed dot product relative to each side's
 * `codeNorm` — but "no closed form" is not "no correction": the ratio the estimator
 * returns is `E[Q(x)Q(y)] / E[Q(x)^2]` for a standard bivariate normal pair, which
 * {@link shrinkageAt} evaluates by quadrature and {@link invertShrinkage} inverts.
 *
 * The rationale that stood here before — that a correction would be "a constant tuned at
 * one dimensionality, and the shrinkage varies with d" — was FALSE ON BOTH HALVES. It is
 * not a constant, because the shrinkage varies with the cosine itself (4.5% between
 * rho = 0.5 and rho = 0.95 at 2 bits), which is exactly why a per-bit scalar gain would
 * not do and a map is needed. And it does not vary with d: {@link getQuantizationParams}
 * divides the loading factor by `sqrt(paddedLen)`, so the standardized grid is IDENTICAL
 * at every dimensionality. Measured across a 32x range of d (128 to 4096) the ratio moves
 * by at most 1.2%, an order of magnitude less than it moves with rho at fixed d.
 *
 * The trades are real and are of the same shape at every corrected width: inverting a map
 * whose slope is below 1 amplifies whatever noise the estimator carries, by `1/g'(0)` near
 * orthogonality where the slope is shallowest. At 1 bit that factor is exactly `pi/2` ≈
 * 1.57 — measured on i.i.d. uniform inputs at d=1024, RMSE against the exact cosine rises
 * from 0.027 to 0.036, paid to remove a bias of up to 0.21. At 2 bits it is 1.13 (1.04 at
 * 3, 1.01 at 4): far milder, and it buys an 8x RMSE cut on correlated pairs, from 0.081 to
 * 0.010 at rho = 0.8. Both are paid in the near-orthogonal regime where the answer is
 * "these are unrelated" either way, and both remove a bias that moved every absolute
 * threshold in one direction.
 *
 * 5-8 bits are left alone; see {@link TURBO_MAX_CORRECTED_BITS}.
 *
 * The correction itself lives in {@link finishCosine}, shared with the prepared-query
 * path — the two entry points must return the same number for the same pair, and the only
 * way to guarantee that is for there to be one copy of this decision.
 */
function quantizedCosine(a: TurboQuantizeResult, b: TurboQuantizeResult): number {
  const { values: valuesA, codeNorm: codeNormA } = reconstructRotatedCodes(a);
  const { values: valuesB, codeNorm: codeNormB } = reconstructRotatedCodes(b);
  if (codeNormA === 0 || codeNormB === 0) return 0;

  let dot = 0;
  for (let i = 0; i < valuesA.length; i++) {
    dot += valuesA[i] * valuesB[i];
  }
  return finishCosine(a.bits, dot / (codeNormA * codeNormB));
}

/**
 * Turns a raw normalized code dot product into the reported cosine: clamp, then undo the
 * shrinkage at the widths where it is corrected.
 *
 * Extracted so {@link quantizedCosine} and {@link turboPreparedCosineSimilarity} cannot
 * drift. They compute the same ratio by different routes — one decodes both sides, the
 * other decodes only the candidate against a pre-normalized query — and a caller who
 * switches to the prepared form for speed must get bit-for-bit the same score, or the
 * optimisation silently changes results. That is exactly the trap the decode-once
 * workaround falls into (see the test that pins it), and it is not a trap worth
 * reproducing inside this module.
 *
 * @param bits - Bit width both records were encoded at
 * @param ratio - Code dot product divided by both code norms
 */
function finishCosine(bits: number, ratio: number): number {
  const cosine = Math.max(-1, Math.min(1, ratio));
  // After the clamp, so the argument is a valid angle even when rounding pushed the
  // ratio a hair past ±1.
  if (bits === 1) return Math.cos((Math.PI * (1 - cosine)) / 2);
  if (bits <= MAX_CORRECTED_BITS) return invertShrinkage(bits, cosine);
  return cosine;
}

/**
 * Computes the approximate cosine similarity between two TurboQuant-quantized vectors.
 *
 * Decodes BOTH sides on every call. Scoring one query against a candidate set should use
 * {@link turboPrepareQuery} + {@link turboPreparedCosineSimilarity} instead, which decodes
 * the query once; see {@link turboQuantizedInnerProduct} for the measurement.
 *
 * @param a - First quantized vector
 * @param b - Second quantized vector
 * @returns Estimated cosine similarity in [-1, 1]
 */
export function turboQuantizedCosineSimilarity(
  a: TurboQuantizeResult,
  b: TurboQuantizeResult
): number {
  assertComparablePair(a, b);
  if (a.norm === 0 || b.norm === 0) return 0;
  return quantizedCosine(a, b);
}

/**
 * A query decoded once, ready to be scored against many candidates.
 *
 * The three scalars are not metadata: they are the compatibility key
 * {@link turboPreparedCosineSimilarity} re-checks on every candidate, exactly as
 * {@link assertComparablePair} does for the pairwise helpers. Preparing a query throws away
 * the record it came from, so without them a candidate encoded at a different bit width or
 * under a different rotation seed would score against these coordinates and return a
 * plausible number computed from two unrelated bases.
 */
export interface TurboPreparedQuery {
  /** Bit width the query was encoded at; a candidate must match. */
  readonly bits: number;
  /** Rotation seed the query was encoded under; a candidate must match. */
  readonly seed: number;
  /** Original dimensionality of the query; a candidate must match. */
  readonly dimensions: number;
  /**
   * The query's rotated-domain reconstruction. Length is the PADDED dimensionality,
   * matching what {@link reconstructRotatedCodes} returns, so the inner loop needs no
   * bounds reconciliation.
   *
   * NOT pre-divided by {@link codeNorm}, and that is deliberate. Folding the query's norm
   * into its coordinates once looks like the obvious optimisation — it removes one
   * multiply per candidate — but it changes `dot / (normA * normB)` into
   * `sum((a_i/normA) * b_i) / normB`, which is a DIFFERENT floating-point expression:
   * measured over 2,000 random pairs at d=1024, the two disagree in the last bits on 96%
   * of them (relative 3e-12). Numerically that is nothing; as an API contract it is the
   * whole point, because it would mean switching a search loop to the prepared form
   * silently changes its scores, and a caller comparing against a stored threshold or a
   * recorded result would see it. Keeping the norm separate makes
   * {@link turboPreparedCosineSimilarity} evaluate the identical expression, so the two
   * paths agree bit for bit by construction rather than by luck. It costs one multiply
   * per candidate against 1024 multiply-adds: measured at 93 ms for the exact form and
   * 96 ms for the pre-divided one over 20,000 candidates, i.e. nothing.
   */
  readonly values: Float64Array;
  /**
   * L2 norm of {@link values}. Zero exactly when the query is degenerate (a zero vector,
   * or codes that reconstruct to zero), the case {@link turboPreparedCosineSimilarity}
   * reports as 0 — mirroring the pairwise helpers.
   */
  readonly codeNorm: number;
}

/**
 * Decodes a query once so it can be scored against many candidates.
 *
 * The pairwise helpers re-decode both sides on every call, which for a search loop means
 * unpacking and reconstructing the QUERY once per candidate. Measured at d=1024 over
 * 20,000 candidates, against {@link turboQuantizedCosineSimilarity}: 230 ms -> 105 ms at
 * 8 bits (2.1x), 180 ms -> 110 ms at 4 bits (1.6x), and 80,000 fewer array allocations
 * (~352 MB less churn) at either width. The corrected widths gain less because they also
 * pay {@link finishCosine}'s table inversion per candidate, which is not query work and
 * cannot be hoisted.
 *
 * The obvious alternative — {@link turboDequantize} the query once, then plain
 * `cosineSimilarity` — is WRONG, and quietly so: it drops the shrinkage correction at 1-4
 * bits, where the raw estimator reads a true 0.80 as 0.59 at 1 bit. This path keeps it, by
 * routing through the same {@link finishCosine} the pairwise helpers use.
 *
 * @param query - The quantized query vector
 * @returns A reusable prepared query
 */
export function turboPrepareQuery(query: TurboQuantizeResult): TurboPreparedQuery {
  assertQuantizeResultShape(query);

  const { bits, seed, dimensions, paddedDimensions, norm } = query;
  // A zero query scores 0 against everything, so it never reaches the dot product and
  // needs no decode — but it still carries a correctly sized `values`, so a caller
  // inspecting the prepared object sees the same shape either way.
  if (norm === 0) {
    return { bits, seed, dimensions, values: new Float64Array(paddedDimensions), codeNorm: 0 };
  }

  const { values, codeNorm } = reconstructRotatedCodes(query);
  return { bits, seed, dimensions, values, codeNorm };
}

/**
 * Cosine similarity between a prepared query and a candidate, decoding only the candidate.
 *
 * Returns bit-for-bit what {@link turboQuantizedCosineSimilarity} returns for the same
 * pair, at every bit width — the shrinkage correction is applied through the shared
 * {@link finishCosine}, and the arithmetic is the same expression with one division
 * hoisted out of the loop. Substituting this for the pairwise helper is a pure speedup
 * with no change in results, which is the only form in which such a substitution is safe.
 *
 * Compatibility is re-checked per candidate rather than trusted: a prepared query is a
 * plain object a caller can hold across a heterogeneous index, and the arithmetic below
 * would happily consume a candidate from a different bit width or rotation basis and
 * return a number.
 *
 * @param query - A query prepared by {@link turboPrepareQuery}
 * @param candidate - The quantized candidate to score
 * @returns Estimated cosine similarity in [-1, 1]
 */
export function turboPreparedCosineSimilarity(
  query: TurboPreparedQuery,
  candidate: TurboQuantizeResult
): number {
  // Same three checks as `assertComparablePair`, in the same order and with the same
  // messages, so a mismatch reads identically whichever entry point hit it.
  if (query.dimensions !== candidate.dimensions) {
    throw new Error("Vectors must have the same dimensions");
  }
  if (query.bits !== candidate.bits) {
    throw new Error("Vectors must use the same bit width");
  }
  if (query.seed !== candidate.seed) {
    throw new Error("Vectors must use the same rotation seed");
  }
  assertQuantizeResultShape(candidate);

  if (query.codeNorm === 0 || candidate.norm === 0) return 0;
  const { values, codeNorm } = reconstructRotatedCodes(candidate);
  if (codeNorm === 0) return 0;

  const queryValues = query.values;
  let dot = 0;
  for (let i = 0; i < values.length; i++) {
    dot += queryValues[i]! * values[i]!;
  }
  // Deliberately `dot / (a * b)`, matching `quantizedCosine` term for term — see
  // {@link TurboPreparedQuery.values} for why the division is not hoisted.
  return finishCosine(query.bits, dot / (query.codeNorm * codeNorm));
}

/**
 * Signed integer target types supported by {@link turboQuantizeToTypedArray}.
 *
 * Unsigned targets are deliberately absent — see the function's documentation.
 */
const SIGNED_TARGET_RANGES = {
  [TensorType.INT8]: { max: 127 },
  [TensorType.INT16]: { max: 32767 },
} as const;

/**
 * Options for {@link turboQuantizeToTypedArray}.
 */
export interface TurboQuantizeToTypedArrayOptions {
  /** Seed for the random rotation. Defaults to {@link DEFAULT_SEED} when undefined. */
  readonly seed: number | undefined;
  /**
   * Accept a non-power-of-2 input length by returning `turboPaddedLength(length)` values
   * instead of throwing. The result is LONGER than the input; a storage column sized to
   * the input dimensionality will not hold it.
   */
  readonly padToPowerOf2: boolean | undefined;
}

/**
 * Quantizes a vector using TurboQuant rotation directly into a byte-aligned TypedArray.
 *
 * Unlike the packed `turboQuantize`, this outputs a standard TypedArray (Int8Array or
 * Int16Array) with the **same `.length`** as the input vector, so it drops into
 * storage backends that expect a fixed-width vector column.
 *
 * ## Signed targets only
 *
 * Only `int8` and `int16` are supported. An unsigned target would need the affine
 * map `x -> (x + scale) / (2 * scale) * max`, whose DC offset (127.5 for uint8)
 * lands on every stored coordinate. Cosine similarity is invariant to scaling but
 * NOT to translation, so that shared component dominates the result: measured at
 * d=1024 / uint8 / seed 42, a true cosine of 0.0559 reads 0.9071 and the whole
 * range collapses to roughly [0.90, 1.00] — negatives become impossible and
 * absolute thresholds meaningless. The offset cannot be subtracted back out at
 * comparison time either: `cosineSimilarity(a, b)` receives only the two arrays,
 * and pgvector / SQLite / DuckDB compute the distance server-side. Unsigned also
 * buys no storage over the signed type of the same width.
 *
 * ## Comparability
 *
 * The output is cosine-comparable ONLY against other outputs of this function
 * produced with the SAME seed. It is not comparable with the unrotated input
 * vector, nor with linearly quantized vectors, nor across seeds — the rotation is
 * a per-seed change of basis, so mixing them yields meaningless rankings with no
 * error raised anywhere.
 *
 * ## Power-of-2 dimensions required, or opt into padding
 *
 * The rotation operates on `turboPaddedLength(d)` coordinates, so a non-power-of-2 `d` has to
 * either widen the output or discard coordinates. This function does the first on request
 * and never the second.
 *
 * Pass `{ padToPowerOf2: true }` to receive a `turboPaddedLength(d)`-length result. Padding
 * keeps the transform orthogonal. The cost is purely the width: the output is LONGER than
 * the input, so a fixed-width storage column must be declared at the padded width.
 *
 * ### What padding actually buys, measured
 *
 * Cosine RMSE against the exact similarity (int8, seed 42, 40 seeded pairs of i.i.d.
 * uniform coordinates), against two different int8 baselines:
 *
 * | d    | padded turbo | L2-then-x127 | max-abs |
 * | ---- | ------------ | ------------ | ------- |
 * | 768  | 0.00034      | 0.00269      | 0.00024 |
 * | 1536 | 0.00024      | 0.00331      | 0.00015 |
 * | 3072 | 0.00021      | 0.00263      | 0.00012 |
 *
 * The middle column is NOT turbo's achievement, and must not be quoted as one. That path
 * divides by the vector's L2 norm, which on a well-spread vector leaves every coordinate
 * near `1/sqrt(d)`, so scaling by 127 emits no code larger than 8 at d=768, 6 at d=1536
 * and 4 at d=3072 — it throws away three of its eight bits before any comparison happens.
 * Beating it measures that defect, not the rotation.
 *
 * Against the honest baseline (divide by `max|v|`, which uses the full code range),
 * padded turbo is 1.4x-1.8x **worse** on these well-conditioned inputs.
 *
 * What the rotation buys is INDEPENDENCE FROM THE INPUT DISTRIBUTION, not a lower error
 * floor. Turbo's error stays in the 0.0001-0.0004 band whatever the input looks like,
 * because the rotation makes every coordinate's marginal the same. Max-abs swings with
 * the input's tail: on Gaussian vectors carrying 2 dimensions at 20x (the "massive
 * activations" real embedding models exhibit), one outlier sets the divisor and crushes
 * every other coordinate toward zero — turbo 0.00039 vs max-abs 0.00174 at d=768, turbo
 * 0.00020 vs max-abs 0.00138 at d=3072.
 *
 * So: prefer padded turbo when the corpus may contain outlier dimensions, or when the
 * embeddings are not under your control. Max-abs int8 is simpler, keeps the input length,
 * and is slightly more accurate when the coordinates are well behaved.
 *
 * Without that option a non-power-of-2 `d` is rejected rather than silently degraded. The
 * rejected alternative is CROPPING — keeping the first `d` of the rotated coordinates —
 * which makes this a lossy random projection rather than an orthogonal rotation: cropped
 * turbo measures 0.0162 at d=768, roughly 50x padded turbo and 70x a max-abs int8
 * quantizer, and 0.0126 at d=1536 / 0.0095 at d=3072. Those figures are recorded here
 * only to explain why the variant is not offered; this function does not emit it, so do
 * not quote them as the cost of turbo at these dimensionalities — padding is.
 *
 * {@link turboQuantize} is unaffected either way: it keeps all `paddedLen` coordinates
 * and stays fully invertible at any dimensionality.
 *
 * Note: The vector norm is not preserved (cosine similarity is scale-invariant,
 * so this is fine for similarity search).
 *
 * @param vector - Input vector (any TypedArray). Must not contain NaN or Infinity.
 * @param targetType - Target signed integer type (INT8 or INT16)
 * @param options - Rotation seed and padding opt-in; omit for {@link DEFAULT_SEED} and no
 *   padding. All vectors in the same collection must use the same seed for similarity
 *   search to work.
 * @returns TypedArray of the target type, with `.length === vector.length` unless
 *   `padToPowerOf2` widened it to `turboPaddedLength(vector.length)`
 */
export function turboQuantizeToTypedArray(
  vector: TypedArray,
  targetType: TensorType,
  options: TurboQuantizeToTypedArrayOptions | undefined
): TypedArray {
  // `Object.hasOwn` before indexing: a plain `[targetType]` lookup would resolve
  // inherited Object.prototype keys, so a name like "constructor" would yield a
  // truthy value and slip past the guard.
  if (!Object.hasOwn(SIGNED_TARGET_RANGES, targetType)) {
    throw new Error(
      `turboQuantizeToTypedArray supports signed integer targets only (int8, int16); "${targetType}" is unsupported. Unsigned targets would encode a DC offset that breaks cosineSimilarity.`
    );
  }
  const { max } = SIGNED_TARGET_RANGES[targetType as keyof typeof SIGNED_TARGET_RANGES];

  const seed = options?.seed ?? DEFAULT_SEED;
  const padToPowerOf2 = options?.padToPowerOf2 ?? false;

  const d = vector.length;
  if (d === 0) {
    throw new Error("Cannot quantize an empty vector");
  }
  assertDimensions(d);
  assertSeed(seed);

  const paddedLen = turboPaddedLength(d);
  if (paddedLen !== d && padToPowerOf2 !== true) {
    throw new Error(
      `turboQuantizeToTypedArray requires a power of 2 dimensionality, got ${d}. ` +
        `Pass { padToPowerOf2: true } to receive ${paddedLen} values instead — padding keeps the ` +
        `rotation orthogonal. The output is then LONGER than the input, so size any fixed-width ` +
        `storage column to ${paddedLen}, not ${d}. Turbo is not automatically the more accurate ` +
        `choice: against a max-abs int8 quantizer (divide by max|v|, then scale to +/-127) padded ` +
        `turbo is slightly WORSE on well-conditioned inputs (int8 cosine RMSE at d=768: 0.00034 vs ` +
        `0.00024) and several times BETTER when the input carries outlier dimensions (0.00039 vs ` +
        `0.00174), which is the trade padding actually buys — distribution-independence, not a ` +
        `lower error floor. Quantize with max-abs int8 instead if the output must keep its ${d} ` +
        `length. Returning only the first ${d} of ${paddedLen} rotated coordinates is not offered: ` +
        `cropping is a lossy random projection and measures 0.0162 here, ~50x padded turbo.`
    );
  }

  // Step 1: Normalize to unit vector
  const { values } = normalizeToUnit(vector);

  // Step 2: Random rotation (spreads information, concentrates distribution)
  const rotated = randomRotate(values, seed);

  // Step 3: Map rotated coordinates to the signed target range. After rotation in
  // paddedLen-dimensional space coordinates have std dev ≈ 1/sqrt(paddedLen), and the
  // clipping range is the MSE-optimal loading factor for this grid. The grid is the signed
  // range INCLUDING zero, so it holds 2 * max + 1 levels — the same helper the packed path
  // uses, solved numerically because that count is never a power of 2.
  const levels = 2 * max + 1;
  const scale = optimalLoadingFactor(levels) / Math.sqrt(paddedLen);

  // Map [-scale, scale] → [-max, max]. Length is paddedLen, which equals d unless the
  // caller opted into padding.
  const result =
    targetType === TensorType.INT8 ? new Int8Array(paddedLen) : new Int16Array(paddedLen);
  for (let i = 0; i < paddedLen; i++) {
    const clamped = Math.max(-scale, Math.min(scale, rotated[i]));
    result[i] = Math.round((clamped / scale) * max);
  }
  return result;
}

/**
 * Calculates the storage size in bytes for a TurboQuant-quantized vector.
 *
 * Because the Walsh-Hadamard transform requires a power-of-2 length, the vector
 * is zero-padded to the next power of 2 before quantization. The codes buffer
 * therefore covers `turboPaddedLength(dimensions)` coordinates, not `dimensions`.
 *
 * @param dimensions - Vector dimensionality
 * @param bits - Bits per dimension (integer, 1-8)
 * @returns Storage size in bytes (codes only, excluding metadata)
 */
export function turboQuantizeStorageBytes(dimensions: number, bits: number): number {
  assertDimensions(dimensions);
  assertBits(bits);
  return Math.ceil((turboPaddedLength(dimensions) * bits) / 8);
}

/**
 * Calculates the compression ratio compared to Float32 storage.
 *
 * @param dimensions - Vector dimensionality
 * @param bits - Bits per dimension (integer, 1-8)
 * @returns Compression ratio (e.g., 8.0 means 8x smaller)
 */
export function turboQuantizeCompressionRatio(dimensions: number, bits: number): number {
  assertDimensions(dimensions);
  assertBits(bits);
  const originalBytes = dimensions * 4; // Float32 = 4 bytes per dim
  const quantizedBytes = turboQuantizeStorageBytes(dimensions, bits);
  return originalBytes / quantizedBytes;
}
