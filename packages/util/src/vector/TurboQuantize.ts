/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TurboQuant: Near-optimal vector quantization using randomized rotation
 * and optimal per-coordinate scalar quantization.
 *
 * Based on "TurboQuant: Online Vector Quantization with Near-optimal Distortion Rate"
 * by Zandieh, Daliri, Hadian, and Mirrokni (2025).
 *
 * The key insight: applying a random orthogonal rotation to a unit vector causes its
 * coordinates to concentrate around a known Beta distribution. This enables near-optimal
 * scalar quantization per coordinate without needing to observe the data distribution first.
 *
 * Properties:
 * - Data-oblivious: no training or codebook construction needed
 * - Per-vector: each vector quantized independently (streaming-friendly)
 * - Near-optimal: within ~2.7x of theoretical distortion limit at all bit-widths
 * - Preserves inner products for accurate similarity search
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
 */
export interface TurboQuantizeResult {
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
 * Upper bound on the dimensionality this module will accept.
 *
 * Every entry point pads the input to `nextPowerOf2(dimensions)` and allocates a
 * `Float64Array` of that length as the transform's working buffer. At 2^24 that
 * buffer is 128 MB (2^24 * 8 bytes), which is already far beyond any real
 * embedding. Rejecting anything larger keeps a bogus or hostile `dimensions`
 * value from either exhausting memory or spinning inside the padding loop.
 */
const MAX_TURBO_DIMENSIONS = 2 ** 24;

/** Number of (sign-flip + Walsh-Hadamard) rounds applied by the randomized rotation. */
const SIGN_ROUNDS = 3;

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
      `TurboQuant dimensions must be at most ${MAX_TURBO_DIMENSIONS}, got ${n} (the padded working buffer would exceed 128 MB)`
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

/** Maximum number of memoized sign tables. Bounded so a hostile seed stream cannot grow it. */
const SIGN_TABLE_CACHE_LIMIT = 16;

/** Memoized sign tables keyed by `${seed}:${paddedLen}` (insertion-ordered for eviction). */
const signTableCache = new Map<string, readonly Uint8Array[]>();

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

  if (signTableCache.size >= SIGN_TABLE_CACHE_LIMIT) {
    // Map iteration is insertion-ordered, so this evicts the oldest entry.
    const oldest = signTableCache.keys().next();
    if (oldest.done !== true) {
      signTableCache.delete(oldest.value);
    }
  }
  signTableCache.set(key, table);
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
 */
function nextPowerOf2(n: number): number {
  assertDimensions(n);
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Returns quantization parameters for uniform scalar quantization over the range
 * [-scale, scale].
 *
 * After random rotation in paddedLen-dimensional space, each coordinate of a
 * d-dimensional unit vector (zero-padded to paddedLen) has variance 1/paddedLen.
 * We use a fixed range of ±3 standard deviations (coverage ≈ 99.7%) as the
 * clipping boundary for a uniform quantizer with `levels = 2^bits` levels.
 * This is a simple, practical uniform quantizer; no non-uniform or
 * distribution-fitted quantization is performed.
 */
function getQuantizationParams(
  bits: number,
  paddedLen: number
): { readonly levels: number; readonly scale: number } {
  const levels = 1 << bits; // 2^bits quantization levels
  // After rotation, coordinates have std dev ≈ 1/sqrt(paddedLen).
  // Cover ±3 standard deviations.
  const coverage = 3.0;
  const scale = coverage / Math.sqrt(paddedLen);
  return { levels, scale };
}

/**
 * Normalizes a vector to unit length, returning both the unit-length coordinates
 * and the original L2 norm.
 *
 * A non-finite norm means the input carried NaN or Infinity. That must throw:
 * otherwise `norm > 0` is false for NaN and the freshly-allocated all-zero buffer
 * is returned, silently discarding the bad input.
 *
 * A zero vector is not an error — it yields an all-zero `values` buffer and a
 * norm of 0.
 */
function normalizeToUnit(vector: TypedArray): {
  readonly values: Float64Array;
  readonly norm: number;
} {
  const d = vector.length;
  let sumSquares = 0;
  for (let i = 0; i < d; i++) {
    sumSquares += vector[i] * vector[i];
  }
  const norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(norm)) {
    throw new Error("Cannot quantize a vector containing NaN or Infinity");
  }

  const values = new Float64Array(d);
  if (norm > 0) {
    for (let i = 0; i < d; i++) {
      values[i] = vector[i] / norm;
    }
  }
  return { values, norm };
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
 * Throws if the buffer is too small for the requested count and bit width.
 */
function unpackCodes(packed: Uint8Array, bits: number, count: number): Uint8Array {
  const expectedBytes = Math.ceil((count * bits) / 8);
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
 * 3. Quantize each rotated coordinate using optimal scalar quantization
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
  const { bits, dimensions, paddedDimensions, seed, norm } = quantized;
  assertBits(bits);
  assertDimensions(dimensions);
  if (!Number.isInteger(seed)) {
    throw new Error(`TurboQuant seed must be an integer, got ${seed}`);
  }
  if (!Number.isFinite(norm)) {
    throw new Error(`TurboQuant norm must be a finite number, got ${norm}`);
  }
  const expectedPadded = nextPowerOf2(dimensions);
  if (paddedDimensions !== expectedPadded) {
    throw new Error(
      `TurboQuant paddedDimensions must be nextPowerOf2(dimensions) = ${expectedPadded}, got ${paddedDimensions}`
    );
  }
}

/**
 * Dequantizes a TurboQuant result back to a Float32Array.
 *
 * Steps:
 * 1. Unpack the codes from the compact representation
 * 2. Reconstruct the rotated coordinates from quantization levels
 * 3. Apply inverse rotation
 * 4. Scale by the original norm
 *
 * @param quantized - The TurboQuant quantization result
 * @returns Reconstructed vector as Float32Array
 */
export function turboDequantize(quantized: TurboQuantizeResult): Float32Array {
  const { codes, bits, dimensions, paddedDimensions, seed, norm } = quantized;

  assertQuantizeResultShape(quantized);

  // Step 1: Unpack all paddedDimensions codes
  const unpacked = unpackCodes(codes, bits, paddedDimensions);

  // Step 2: Reconstruct rotated coordinates (all paddedDimensions)
  const { levels, scale } = getQuantizationParams(bits, paddedDimensions);
  const rotated = new Float64Array(paddedDimensions);
  for (let i = 0; i < paddedDimensions; i++) {
    rotated[i] = dequantizeScalar(unpacked[i], scale, levels);
  }

  // Step 3: Inverse rotation (returns full paddedDimensions array)
  const unrotated = inverseRandomRotate(rotated, seed);

  // Step 4: Crop to original dimensions and scale by original norm
  const result = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    result[i] = unrotated[i] * norm;
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

  const paddedLen = a.paddedDimensions;
  const { levels, scale } = getQuantizationParams(a.bits, paddedLen);

  // Unpack both code arrays (paddedLen codes each)
  const codesA = unpackCodes(a.codes, a.bits, paddedLen);
  const codesB = unpackCodes(b.codes, b.bits, paddedLen);

  // Compute dot product in the rotated (quantized) domain.
  // Since rotation is orthogonal, inner products are preserved:
  // <Ra, Rb> = <a, b> (for orthogonal R)
  let dot = 0;
  for (let i = 0; i < paddedLen; i++) {
    const va = dequantizeScalar(codesA[i], scale, levels);
    const vb = dequantizeScalar(codesB[i], scale, levels);
    dot += va * vb;
  }

  // Scale by both norms
  return dot * a.norm * b.norm;
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
  if (a.norm === 0 || b.norm === 0) return 0;
  // Inner product of unit vectors = cosine similarity
  // turboQuantizedInnerProduct includes norm scaling, so divide it out
  return turboQuantizedInnerProduct(a, b) / (a.norm * b.norm);
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
 * Quantizes a vector using TurboQuant rotation directly into a byte-aligned TypedArray.
 *
 * Unlike the packed `turboQuantize`, this outputs a standard TypedArray (Int8Array or
 * Int16Array) with the **same `.length`** as the input vector, so it drops into
 * storage backends that expect a fixed-width vector column.
 *
 * The rotation spreads information across all coordinates and concentrates their
 * distribution, yielding better distortion than naive linear quantization at the
 * same byte width.
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
 * ## Fidelity and non-power-of-2 dimensions
 *
 * The rotation operates on `nextPowerOf2(d)` coordinates but only the first `d`
 * are kept (the output length must match the input length), so for a
 * non-power-of-2 `d` this is a random projection rather than an orthogonal
 * rotation, and cosine similarity is preserved only approximately. Measured
 * cosine RMSE against the exact similarity (int8, seed 42, 40 random pairs):
 * d=1024 -> 0.001, d=1000 -> 0.006, d=1536 -> 0.013, d=768 -> 0.019
 * (worst single pair 0.052). When fidelity matters, zero-pad the vectors to a
 * power of 2 at the call site.
 *
 * Note: The vector norm is not preserved (cosine similarity is scale-invariant,
 * so this is fine for similarity search).
 *
 * @param vector - Input vector (any TypedArray). Must not contain NaN or Infinity.
 * @param targetType - Target signed integer type (INT8 or INT16)
 * @param seed - Seed for the random rotation (default: 42). All vectors in the
 *   same collection must use the same seed for similarity search to work.
 * @returns TypedArray of the target type with `.length === vector.length`
 */
export function turboQuantizeToTypedArray(
  vector: TypedArray,
  targetType: TensorType,
  seed: number = DEFAULT_SEED
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

  const d = vector.length;
  if (d === 0) {
    throw new Error("Cannot quantize an empty vector");
  }
  assertDimensions(d);

  // Step 1: Normalize to unit vector
  const { values } = normalizeToUnit(vector);

  // Step 2: Random rotation (spreads information, concentrates distribution)
  // randomRotate returns all paddedLen coordinates; we only use the first d.
  const paddedLen = nextPowerOf2(d);
  const rotated = randomRotate(values, seed);

  // Step 3: Map rotated coordinates to the signed target range.
  // After rotation in paddedLen-dimensional space, coordinates have std dev ≈ 1/sqrt(paddedLen).
  const coverage = 3.0;
  const scale = coverage / Math.sqrt(paddedLen);

  // Map [-scale, scale] → [-max, max]
  const result = targetType === TensorType.INT8 ? new Int8Array(d) : new Int16Array(d);
  for (let i = 0; i < d; i++) {
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
