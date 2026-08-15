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
 * ## Similarity is biased LOW at low bit widths
 *
 * Magnitude is unbiased; similarity is not. Clipping and rounding shrink the reconstructed
 * dot product relative to each side's `codeNorm`, so
 * {@link turboQuantizedCosineSimilarity} — and {@link turboQuantizedInnerProduct}, which
 * is that times the two norms — systematically UNDER-report similar pairs. Mean signed
 * error against the exact cosine, 32 correlated pairs per cell, d=1024, seeded:
 *
 * | bits | true 0.50 | true 0.80 | true 0.95 |
 * | ---- | --------- | --------- | --------- |
 * | 1    |  +0.002   |  +0.001   |  -0.000   |
 * | 2    |  -0.056   |  -0.080   |  -0.075   |
 * | 3    |  -0.017   |  -0.027   |  -0.028   |
 * | 4    |  -0.005   |  -0.007   |  -0.009   |
 * | 5    |  -0.002   |  -0.003   |  -0.003   |
 * | 6    |  -0.000   |  -0.001   |  -0.001   |
 * | 7    |  -0.000   |  -0.000   |  -0.000   |
 * | 8    |  -0.000   |  -0.000   |  -0.000   |
 *
 * The 1-bit row is zero because that case alone HAS a closed form and is corrected: a
 * 2-level grid is exactly ±scale, so the estimator degenerates to the sign-agreement
 * statistic `1 - 2*theta/pi`, which `quantizedCosine` inverts. At 2-8 bits there is no
 * closed form, and a fitted gain would be tuned at one dimensionality and wrong at the
 * next — so the bias is documented rather than papered over. That is why 2 bits, four
 * times finer than 1, is the worst row in the table.
 *
 * RANKING SURVIVES this — the shrinkage is monotone in the true cosine, so ordering a
 * candidate set is unaffected. ABSOLUTE THRESHOLDS AND CALIBRATION DO NOT. At 2 bits a
 * `cos > 0.8` cut (an ordinary RAG threshold) drops pairs whose real cosine is 0.87. Use
 * 4 bits or more when a stored threshold has to mean what it says, or re-tune the
 * threshold against the table above.
 *
 * Properties:
 * - Data-oblivious: no training or codebook construction needed
 * - Per-vector: each vector quantized independently (streaming-friendly)
 * - Preserves the RANKING induced by inner products and cosine similarity
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

const DEFAULT_SEED = 42;

/**
 * Current {@link TurboQuantizeResult.version}. Bump whenever the mapping between stored
 * codes and reconstructed values changes (grid, loading factor, rotation, packing).
 */
const TURBO_QUANTIZE_VERSION = 1;

/**
 * Upper bound on the dimensionality this module will accept.
 *
 * Every entry point pads the input to `nextPowerOf2(dimensions)` and allocates several
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
  const paddedLen = nextPowerOf2(d);
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
 */
export function nextPowerOf2(n: number): number {
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
 * (255 for int8, 65535 for int16) and so is never in the table. The numeric solution
 * reproduces the tabulated values to within 0.35% (0.00% at 64 levels), which is what
 * pins the two paths to the same curve.
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
 */
function normalizeToUnit(vector: TypedArray): {
  readonly values: Float64Array;
  readonly norm: number;
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
    return { values, norm: 0 };
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
  return { values, norm: maxAbs * rootS };
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
  const { values, norm } = normalizeToUnit(vector);

  // Step 2: Random rotation — returns all paddedLen coordinates
  const paddedLen = nextPowerOf2(d);
  const rotated = randomRotate(values, seed);

  // Step 3: Scalar quantization per coordinate (all paddedLen)
  const { levels, scale } = getQuantizationParams(bits, paddedLen);
  const codes: number[] = new Array(paddedLen);
  for (let i = 0; i < paddedLen; i++) {
    codes[i] = quantizeScalar(rotated[i], scale, levels);
  }

  // Step 4: Pack into compact representation
  const packed = packCodes(codes, bits);

  return {
    version: TURBO_QUANTIZE_VERSION,
    codes: packed,
    bits,
    dimensions: d,
    paddedDimensions: paddedLen,
    seed,
    norm,
  };
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
  const expectedPadded = nextPowerOf2(dimensions);
  if (paddedDimensions !== expectedPadded) {
    throw new Error(
      `TurboQuant paddedDimensions must be nextPowerOf2(dimensions) = ${expectedPadded}, got ${paddedDimensions}`
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
 * Estimates the inner product between two TurboQuant-quantized vectors
 * without full dequantization. This is faster than dequantizing both vectors
 * and computing the dot product, though for maximum accuracy, full
 * dequantization is preferred.
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
 * The inversion is NOT extended to 2-8 bits, where the shrinkage is ordinary quantization
 * error (clipping and rounding shrink the reconstructed dot product relative to each
 * side's `codeNorm`) with no closed form to invert. A fitted per-bit gain would be a
 * constant tuned at one dimensionality, and the shrinkage varies with d — so it would
 * correct one corpus and skew the next. That residual bias is documented in the module
 * header instead, with the measured per-bit table.
 *
 * The trade at 1 bit is real: the derivative of `cos(pi*(1 - r)/2)` peaks at ~pi/2 ≈ 1.57
 * near theta = pi/2, so whatever noise the sign statistic carries is amplified by up to
 * ~1.57x for near-orthogonal pairs. Measured on i.i.d. uniform inputs at d=1024, RMSE
 * against the exact cosine rises from 0.027 to 0.036 — paid to remove a bias of up to
 * 0.21, and paid in the regime where the answer is "these are unrelated" either way.
 */
function quantizedCosine(a: TurboQuantizeResult, b: TurboQuantizeResult): number {
  const { values: valuesA, codeNorm: codeNormA } = reconstructRotatedCodes(a);
  const { values: valuesB, codeNorm: codeNormB } = reconstructRotatedCodes(b);
  if (codeNormA === 0 || codeNormB === 0) return 0;

  let dot = 0;
  for (let i = 0; i < valuesA.length; i++) {
    dot += valuesA[i] * valuesB[i];
  }
  const cosine = Math.max(-1, Math.min(1, dot / (codeNormA * codeNormB)));
  // After the clamp, so the argument is a valid angle even when rounding pushed the
  // ratio a hair past ±1.
  if (a.bits === 1) return Math.cos((Math.PI * (1 - cosine)) / 2);
  return cosine;
}

/**
 * Computes the approximate cosine similarity between two TurboQuant-quantized vectors.
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
  /** Seed for the random rotation. Defaults to the module default when undefined. */
  readonly seed: number | undefined;
  /**
   * Accept a non-power-of-2 input length by returning `nextPowerOf2(length)` values
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
 * The rotation operates on `nextPowerOf2(d)` coordinates, so a non-power-of-2 `d` has to
 * either widen the output or discard coordinates. This function does the first on request
 * and never the second.
 *
 * Pass `{ padToPowerOf2: true }` to receive a `nextPowerOf2(d)`-length result. Padding
 * keeps the transform orthogonal, and at that width TurboQuant is the more accurate
 * choice by a wide margin — cosine RMSE against the exact similarity (int8, seed 42, 40
 * seeded pairs), padded turbo vs linear quantization: 0.00034 vs 0.00269 at d=768
 * (MiniLM), 0.00024 vs 0.00331 at d=1536, 0.00021 vs 0.00263 at d=3072. The cost is
 * purely the width: the output is LONGER than the input, so a fixed-width storage column
 * must be declared at the padded width.
 *
 * Without that option a non-power-of-2 `d` is rejected rather than silently degraded. The
 * rejected alternative is CROPPING — keeping the first `d` of the rotated coordinates —
 * which makes this a lossy random projection rather than an orthogonal rotation and
 * measures worse than plain linear quantization at exactly the sizes real embedding
 * models use: cropped turbo vs linear, 0.0164 vs 0.0027 at d=768, 0.0126 vs 0.0033 at
 * d=1536, 0.0094 vs 0.0026 at d=3072. Those cropped figures are recorded here only to
 * explain why the variant is not offered; this function no longer emits it, so do not
 * quote them as the cost of turbo at these dimensionalities — padding is.
 *
 * {@link turboQuantize} is unaffected either way: it keeps all `paddedLen` coordinates
 * and stays fully invertible at any dimensionality.
 *
 * Note: The vector norm is not preserved (cosine similarity is scale-invariant,
 * so this is fine for similarity search).
 *
 * @param vector - Input vector (any TypedArray). Must not contain NaN or Infinity.
 * @param targetType - Target signed integer type (INT8 or INT16)
 * @param seedOrOptions - Rotation seed (default: 42), or an options object. All vectors in
 *   the same collection must use the same seed for similarity search to work.
 * @returns TypedArray of the target type, with `.length === vector.length` unless
 *   `padToPowerOf2` widened it to `nextPowerOf2(vector.length)`
 */
export function turboQuantizeToTypedArray(
  vector: TypedArray,
  targetType: TensorType,
  seedOrOptions: number | TurboQuantizeToTypedArrayOptions = DEFAULT_SEED
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

  const seed =
    typeof seedOrOptions === "number" ? seedOrOptions : (seedOrOptions.seed ?? DEFAULT_SEED);
  const padToPowerOf2 = typeof seedOrOptions === "number" ? false : seedOrOptions.padToPowerOf2;

  const d = vector.length;
  if (d === 0) {
    throw new Error("Cannot quantize an empty vector");
  }
  assertDimensions(d);
  assertSeed(seed);

  const paddedLen = nextPowerOf2(d);
  if (paddedLen !== d && padToPowerOf2 !== true) {
    throw new Error(
      `turboQuantizeToTypedArray requires a power of 2 dimensionality, got ${d}. ` +
        `Pass { padToPowerOf2: true } to receive ${paddedLen} values instead — padding keeps the ` +
        `rotation orthogonal and is the most accurate option at this size (int8 cosine RMSE at ` +
        `d=768: padded turbo 0.00034 vs linear 0.00269), at the cost of an output LONGER than the ` +
        `input, so size any fixed-width storage column to ${paddedLen}. Quantize linearly instead ` +
        `if the output must keep its ${d} length. Returning only the first ${d} of ${paddedLen} ` +
        `rotated coordinates is not offered: cropping is a lossy random projection that measures ` +
        `worse than linear here (0.0164 vs 0.0027).`
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
 * therefore covers `nextPowerOf2(dimensions)` coordinates, not `dimensions`.
 *
 * @param dimensions - Vector dimensionality
 * @param bits - Bits per dimension (integer, 1-8)
 * @returns Storage size in bytes (codes only, excluding metadata)
 */
export function turboQuantizeStorageBytes(dimensions: number, bits: number): number {
  assertDimensions(dimensions);
  assertBits(bits);
  return Math.ceil((nextPowerOf2(dimensions) * bits) / 8);
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
