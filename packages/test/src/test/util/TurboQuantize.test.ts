/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { setLogger } from "@workglow/util";
import type { TurboQuantizeResult } from "@workglow/util/schema";
import {
  TensorType,
  clearSignTableCache,
  cosineSimilarity,
  inner,
  magnitude,
  turboDequantize,
  turboQuantize,
  turboQuantizeCompressionRatio,
  turboQuantizeStorageBytes,
  turboQuantizeToTypedArray,
  turboQuantizedCosineSimilarity,
  turboQuantizedInnerProduct,
} from "@workglow/util/schema";
import { getTestingLogger } from "@workglow/util/test";
import { describe, expect, test } from "vitest";

/**
 * Deterministic PRNG (mulberry32) so the fidelity tests below never depend on
 * `Math.random` — a flaky bound here would be indistinguishable from a real
 * regression.
 */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("TurboQuantize", () => {
  let logger = getTestingLogger();
  setLogger(logger);

  describe("turboQuantize", () => {
    test("should quantize a Float32Array vector", () => {
      const vector = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const result = turboQuantize(vector, { bits: 4, seed: 42 });

      expect(result.bits).toBe(4);
      expect(result.dimensions).toBe(8);
      expect(result.seed).toBe(42);
      expect(result.norm).toBeCloseTo(magnitude(vector), 5);
      expect(result.codes).toBeInstanceOf(Uint8Array);
    });

    test("should quantize with default options", () => {
      const vector = new Float32Array([1, 2, 3, 4]);
      const result = turboQuantize(vector, undefined);

      expect(result.bits).toBe(4);
      expect(result.seed).toBe(42);
      expect(result.dimensions).toBe(4);
    });

    test("should produce compact storage at low bit widths", () => {
      const vector = new Float32Array(768); // typical embedding dimension
      for (let i = 0; i < 768; i++) vector[i] = Math.sin(i * 0.1);

      const result4bit = turboQuantize(vector, { bits: 4, seed: 42 });
      const result2bit = turboQuantize(vector, { bits: 2, seed: 42 });

      // 768 pads to 1024 (next power of 2):
      // 4-bit: 1024 * 4 / 8 = 512 bytes
      expect(result4bit.codes.length).toBe(512);
      expect(result4bit.paddedDimensions).toBe(1024);
      // 2-bit: 1024 * 2 / 8 = 256 bytes
      expect(result2bit.codes.length).toBe(256);
      expect(result2bit.paddedDimensions).toBe(1024);
    });

    test("should reject invalid bit widths", () => {
      const vector = new Float32Array([1, 2, 3, 4]);
      expect(() => turboQuantize(vector, { bits: 0, seed: 42 })).toThrow();
      expect(() => turboQuantize(vector, { bits: 9, seed: 42 })).toThrow();
      expect(() => turboQuantize(vector, { bits: 3.5, seed: 42 })).toThrow();
    });

    test("should reject empty vectors", () => {
      const vector = new Float32Array(0);
      expect(() => turboQuantize(vector, { bits: 4, seed: 42 })).toThrow();
    });

    test("should handle zero vectors", () => {
      const vector = new Float32Array([0, 0, 0, 0]);
      const result = turboQuantize(vector, { bits: 4, seed: 42 });
      expect(result.norm).toBe(0);
    });

    test("should reject NaN and Infinity inputs", () => {
      expect(() =>
        turboQuantize(new Float32Array([1, 2, NaN, 4, 5, 6, 7, 8]), { bits: 4, seed: 42 })
      ).toThrow("NaN or Infinity");
      expect(() =>
        turboQuantize(new Float32Array([1, 2, Infinity, 4, 5, 6, 7, 8]), { bits: 4, seed: 42 })
      ).toThrow("NaN or Infinity");
      expect(() =>
        turboQuantize(new Float32Array([1, 2, -Infinity, 4, 5, 6, 7, 8]), { bits: 4, seed: 42 })
      ).toThrow("NaN or Infinity");
      expect(() =>
        turboQuantizeToTypedArray(new Float32Array([1, 2, NaN, 4, 5, 6, 7, 8]), TensorType.INT8, 42)
      ).toThrow("NaN or Infinity");
      expect(() =>
        turboQuantizeToTypedArray(
          new Float32Array([1, 2, Infinity, 4, 5, 6, 7, 8]),
          TensorType.INT8,
          42
        )
      ).toThrow("NaN or Infinity");
    });

    test("should quantize a vector whose squared norm overflows a double", () => {
      // `sumSquares += v * v` squares the exponent, so it reached Infinity at ~1e154 —
      // far below where the vector itself stops being representable. `Math.sqrt(Infinity)`
      // is Infinity, which the finiteness guard then reported as "NaN or Infinity" for an
      // input containing neither.
      const huge = new Float64Array([1e200, 2e200, 3e200, 4e200]);
      const reference = turboQuantize(new Float64Array([1, 2, 3, 4]), { bits: 8, seed: 42 });
      const quantized = turboQuantize(huge, { bits: 8, seed: 42 });

      expect(Number.isFinite(quantized.norm)).toBe(true);
      expect(quantized.norm / 1e200).toBeCloseTo(Math.sqrt(30), 10);
      // Scaling an input by a constant changes only the recorded norm: the direction is
      // identical, so the codes must be too.
      expect(Array.from(quantized.codes)).toEqual(Array.from(reference.codes));
      expect(turboQuantizedCosineSimilarity(quantized, quantized)).toBeCloseTo(1, 10);
      expect(turboQuantizedCosineSimilarity(quantized, reference)).toBeCloseTo(1, 10);

      // Encoding succeeds; only the Float32 decode cannot represent it, and it says so
      // rather than returning a vector of Infinity.
      expect(() => turboDequantize(quantized)).toThrow(/exceeds the Float32 range/);
      expect(() => turboDequantize(quantized)).not.toThrow(/NaN or Infinity/);
    });

    test("should quantize a vector whose squared norm underflows a double", () => {
      // The mirror failure: below ~1e-162 every `v * v` flushed to zero, so `norm` came
      // back 0 — indistinguishable from a genuine zero vector. The record then decoded to
      // all zeroes and scored 0 against itself, silently discarding a perfectly good
      // direction.
      const tiny = new Float64Array([1e-200, 2e-200, 3e-200, 4e-200]);
      const reference = turboQuantize(new Float64Array([1, 2, 3, 4]), { bits: 8, seed: 42 });
      const quantized = turboQuantize(tiny, { bits: 8, seed: 42 });

      expect(quantized.norm).toBeGreaterThan(0);
      expect(quantized.norm * 1e200).toBeCloseTo(Math.sqrt(30), 10);
      expect(Array.from(quantized.codes)).toEqual(Array.from(reference.codes));
      expect(turboQuantizedCosineSimilarity(quantized, quantized)).toBeCloseTo(1, 10);

      // Honest limitation: this record cannot round-trip through `turboDequantize`, and
      // that is not a bug being papered over. The reconstruction is a Float32Array and
      // 1e-200 is far below Float32's smallest subnormal (~1.4e-45), so every coordinate
      // legitimately flushes to zero. The payoff of keeping the norm alive for a tiny
      // vector is that SIMILARITY works — asserted above — not that decode does.
      expect(Array.from(turboDequantize(quantized))).toEqual([0, 0, 0, 0]);
    });

    test("should keep an ordinary vector bit-identical across the norm rescaling", () => {
      // The max-scaled norm is a different arithmetic sequence than `sum(v*v)`, so it has
      // to be shown NOT to move the encoding of ordinary inputs: TURBO_QUANTIZE_VERSION
      // stays 1 only if the code-to-value mapping is untouched. `turboDequantize` is a
      // function of (codes, norm, seed, dimensions) alone, so identical codes and an
      // identical norm are exactly what make the decode bit-identical.
      const quantized = turboQuantize(new Float64Array([1, 2, 3, 4]), { bits: 8, seed: 42 });

      expect(quantized.version).toBe(1);
      expect(quantized.norm).toBe(Math.sqrt(30));
      expect(Array.from(quantized.codes)).toEqual([175, 104, 163, 116]);
      expect(Array.from(turboDequantize(quantized))).toEqual([
        0.9718117117881775, 1.9858760833740234, 2.9999403953552246, 4.014004707336426,
      ]);
    });

    test("should still reject a genuinely zero vector's direction, not a tiny one", () => {
      // Max-scaling has to keep the one case that legitimately yields norm 0 distinct from
      // the underflow case it fixes.
      const zero = turboQuantize(new Float64Array([0, 0, 0, 0]), { bits: 8, seed: 42 });
      expect(zero.norm).toBe(0);
      expect(Array.from(turboDequantize(zero))).toEqual([0, 0, 0, 0]);
    });

    test("should reject a decode whose recorded norm is negative", () => {
      // `norm` is always a Math.sqrt result, so a negative one is corrupt. The decode
      // multiplies by it, so it silently sign-flips every coordinate: the reconstruction
      // scores -1 against its own source with nothing reported anywhere.
      const quantized = turboQuantize(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]), {
        bits: 8,
        seed: 42,
      });

      const negative = { ...quantized, norm: -quantized.norm };
      expect(() => turboDequantize(negative)).toThrow(/non-negative/);
      expect(() => turboQuantizedInnerProduct(negative, quantized)).toThrow(/non-negative/);
      expect(() => turboQuantizedCosineSimilarity(negative, quantized)).toThrow(/non-negative/);
    });

    test("should match hardcoded golden bytes (cross-process determinism)", () => {
      // Literal expectations, not a second in-process call: only a checked-in
      // byte sequence can catch a non-deterministic (e.g. Math.random) regression
      // introduced elsewhere in the rotation path.
      const codes = Array.from(
        turboQuantize(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]), { bits: 4, seed: 42 }).codes
      );
      expect(codes).toEqual([117, 180, 195, 133]);

      const v64 = new Float32Array(64);
      for (let i = 0; i < 64; i++) v64[i] = Math.sin(i * 0.7) * ((i % 5) + 1);
      const first16 = Array.from(
        turboQuantizeToTypedArray(v64, TensorType.INT8, 42).slice(0, 16) as Int8Array
      );
      expect(first16).toEqual([
        16, -22, -15, -30, -17, -17, 35, 8, -34, -13, -31, -71, 8, 27, -10, -13,
      ]);
    });

    test("should reject a decode whose codes are not a Uint8Array", () => {
      // TurboQuantizeResult is a plain serializable record, so the obvious way to persist
      // one is JSON. That turns `codes` into a plain object with no usable `length`, and
      // `undefined < expectedBytes` is false — so a size-only guard waves it through and
      // every byte reads back as NaN -> code 0, decoding to a confident vector of garbage.
      const quantized = turboQuantize(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]), {
        bits: 4,
        seed: 42,
      });

      const shapes: readonly TurboQuantizeResult[] = [
        JSON.parse(JSON.stringify(quantized)) as TurboQuantizeResult,
        { ...quantized, codes: { "0": 1, "1": 2 } as unknown as Uint8Array },
        { ...quantized, codes: Array.from(quantized.codes) as unknown as Uint8Array },
      ];

      for (const broken of shapes) {
        expect(() => turboDequantize(broken)).toThrow(/Uint8Array/);
        expect(() => turboQuantizedInnerProduct(broken, quantized)).toThrow(/Uint8Array/);
        expect(() => turboQuantizedCosineSimilarity(broken, quantized)).toThrow(/Uint8Array/);
      }
    });

    test("should accept a JSON-restored record once its codes are rebuilt", () => {
      // The counterpart to the guard above: rebuilding the Uint8Array is all that is
      // needed, so the guard rejects a broken carrier rather than a legitimate record.
      const quantized = turboQuantize(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]), {
        bits: 8,
        seed: 42,
      });
      const restored = JSON.parse(JSON.stringify(quantized)) as TurboQuantizeResult;
      const repaired: TurboQuantizeResult = {
        ...restored,
        codes: Uint8Array.from(Object.values(restored.codes as unknown as Record<string, number>)),
      };

      expect(turboQuantizedCosineSimilarity(repaired, quantized)).toBeCloseTo(1, 6);
    });

    test("should reject a record whose version this build does not support", () => {
      const quantized = turboQuantize(new Float32Array([1, 2, 3, 4]), { bits: 4, seed: 42 });
      expect(quantized.version).toBe(1);

      const future = { ...quantized, version: 2 };
      expect(() => turboDequantize(future)).toThrow(/version 2 is not supported/);
      expect(() => turboQuantizedInnerProduct(future, quantized)).toThrow(
        /version 2 is not supported/
      );
    });

    test("should reject a non-integer or out-of-int32-range seed at encode time", () => {
      // Encode-side validation matters more than decode-side: a record written with a
      // seed this module cannot reproduce is data that can never be read back.
      const vector = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);

      expect(() => turboQuantize(vector, { bits: 4, seed: 1.5 })).toThrow(/seed/);
      expect(() => turboQuantize(vector, { bits: 4, seed: 2 ** 32 + 1 })).toThrow(/seed/);
      expect(() => turboQuantize(vector, { bits: 4, seed: NaN })).toThrow(/seed/);
      expect(() => turboQuantizeToTypedArray(vector, TensorType.INT8, 1.5)).toThrow(/seed/);
      expect(() => turboQuantizeToTypedArray(vector, TensorType.INT8, 2 ** 32 + 1)).toThrow(/seed/);

      // The int32 window itself stays usable at both ends.
      expect(() => turboQuantize(vector, { bits: 4, seed: -(2 ** 31) })).not.toThrow();
      expect(() => turboQuantize(vector, { bits: 4, seed: 2 ** 31 - 1 })).not.toThrow();
    });

    test("should support different TypedArray inputs", () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8];
      const f32 = turboQuantize(new Float32Array(values), { bits: 4, seed: 42 });
      const f64 = turboQuantize(new Float64Array(values), { bits: 4, seed: 42 });
      const i8 = turboQuantize(new Int8Array(values), { bits: 4, seed: 42 });

      expect(f32.dimensions).toBe(8);
      expect(f64.dimensions).toBe(8);
      expect(i8.dimensions).toBe(8);
    });

    test("should produce deterministic results with same seed", () => {
      const vector = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const r1 = turboQuantize(vector, { bits: 4, seed: 123 });
      const r2 = turboQuantize(vector, { bits: 4, seed: 123 });

      expect(r1.codes).toEqual(r2.codes);
      expect(r1.norm).toBe(r2.norm);
    });

    test("should produce different results with different seeds", () => {
      const vector = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const r1 = turboQuantize(vector, { bits: 4, seed: 1 });
      const r2 = turboQuantize(vector, { bits: 4, seed: 2 });

      // Norms should be the same (same input vector)
      expect(r1.norm).toBeCloseTo(r2.norm, 5);
      // But codes should differ (different rotations)
      expect(r1.codes).not.toEqual(r2.codes);
    });
  });

  describe("turboDequantize", () => {
    test("should reconstruct vectors with reasonable fidelity at 8 bits", () => {
      const original = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const quantized = turboQuantize(original, { bits: 8, seed: 42 });
      const reconstructed = turboDequantize(quantized);

      expect(reconstructed.length).toBe(original.length);
      expect(reconstructed).toBeInstanceOf(Float32Array);

      // At 8 bits, reconstruction should be quite close
      const sim = cosineSimilarity(original, reconstructed);
      expect(sim).toBeGreaterThan(0.95);
    });

    test("should reconstruct vectors with acceptable fidelity at 4 bits", () => {
      // Use a higher-dimensional vector where TurboQuant shines
      const d = 128;
      const original = new Float32Array(d);
      for (let i = 0; i < d; i++) original[i] = Math.sin(i * 0.1) + Math.cos(i * 0.3);

      const quantized = turboQuantize(original, { bits: 4, seed: 42 });
      const reconstructed = turboDequantize(quantized);

      const sim = cosineSimilarity(original, reconstructed);
      expect(sim).toBeGreaterThan(0.9);
    });

    test("should preserve vector norm approximately", () => {
      const original = new Float32Array([3, 4, 5, 6, 7, 8, 9, 10]);
      const origNorm = magnitude(original);

      const quantized = turboQuantize(original, { bits: 8, seed: 42 });
      const reconstructed = turboDequantize(quantized);
      const reconNorm = magnitude(reconstructed);

      // Norm should be approximately preserved
      expect(reconNorm).toBeCloseTo(origNorm, 0);
    });

    test("should return zero vector for quantized zero vector", () => {
      const original = new Float32Array([0, 0, 0, 0]);
      const quantized = turboQuantize(original, { bits: 4, seed: 42 });
      const reconstructed = turboDequantize(quantized);

      for (let i = 0; i < reconstructed.length; i++) {
        expect(Math.abs(reconstructed[i])).toBe(0);
      }
    });

    test("should reject a paddedDimensions that is not nextPowerOf2(dimensions)", () => {
      // TurboQuantizeResult is a plain serializable record, so a persisted or
      // mismatched value can reach the decode path with a bogus padded length.
      // Without the guard the Walsh-Hadamard butterfly reads past the buffer and
      // silently returns NaN.
      const quantized = turboQuantize(new Float32Array([1, 2, 3, 4, 5, 6]), { bits: 4, seed: 42 });
      expect(quantized.paddedDimensions).toBe(8);

      const tampered = { ...quantized, paddedDimensions: 6 };
      expect(() => turboDequantize(tampered)).toThrow("paddedDimensions");
      expect(() => turboQuantizedInnerProduct(tampered, quantized)).toThrow("paddedDimensions");
      expect(() => turboQuantizedInnerProduct(quantized, tampered)).toThrow("paddedDimensions");
    });

    /**
     * Relative L2 error of the reconstruction, per bit width, for one seeded vector.
     * Returned alongside the magnitude ratio so the caller can assert both against one run.
     */
    function measureRelativeL2(
      d: number,
      randomSeed: number
    ): { readonly relativeL2: readonly number[]; readonly magnitudeRatios: readonly number[] } {
      const rnd = makeRandom(randomSeed);
      const original = new Float32Array(d);
      for (let i = 0; i < d; i++) original[i] = rnd() - 0.5;

      let originalEnergy = 0;
      for (let i = 0; i < d; i++) originalEnergy += original[i] * original[i];

      const relativeL2: number[] = [];
      const magnitudeRatios: number[] = [];
      for (let bits = 1; bits <= 8; bits++) {
        const reconstructed = turboDequantize(turboQuantize(original, { bits, seed: 42 }));
        let errorEnergy = 0;
        for (let i = 0; i < d; i++) {
          const delta = reconstructed[i] - original[i];
          errorEnergy += delta * delta;
        }
        relativeL2.push(Math.sqrt(errorEnergy / originalEnergy));
        magnitudeRatios.push(magnitude(reconstructed) / magnitude(original));
      }
      return { relativeL2, magnitudeRatios };
    }

    test("should reduce relative L2 error monotonically with bit width", () => {
      // The monotonicity assertion is the point of this test. With a bits-independent
      // 3-sigma clipping range, clipping error dominated everything the extra levels
      // bought and relative L2 flattened out: 6, 7 and 8 bits all landed at ~0.035, so
      // four times the levels bought nothing. Per-bit ceilings alone would not catch a
      // regression back to a flat tail; requiring each step to be a real improvement does.
      //
      // Measured relative L2 here, shipped grid vs a fixed 3-sigma one:
      //   shipped 0.635 0.347 0.189 0.110 0.065 0.038 0.021 0.010
      //   3-sigma 0.635 0.523 0.243 0.123 0.065 0.043 0.035 0.033
      // The ceilings below pass the first row and reject the second at 2 bits.
      const { relativeL2, magnitudeRatios } = measureRelativeL2(1024, 42);

      const ceilings = [0.75, 0.45, 0.26, 0.15, 0.09, 0.05, 0.028, 0.016];
      relativeL2.forEach((value, index) => {
        expect(value).toBeLessThan(ceilings[index]);
      });
      for (let i = 0; i + 1 < relativeL2.length; i++) {
        expect(relativeL2[i + 1]).toBeLessThan(relativeL2[i] * 0.85);
      }

      // Magnitude preservation folded in as a one-line invariant rather than a test of its
      // own: `turboDequantize` renormalizes to the recorded norm unconditionally, so this
      // ratio is 1 for every input, bit width and grid and can never fail on its own. It
      // is worth one assertion next to a measurement that CAN fail, and worth nothing
      // apart from it.
      for (const ratio of magnitudeRatios) expect(ratio).toBeCloseTo(1, 5);
    });

    test("should reduce relative L2 error monotonically at a cropped (d=768) dimensionality", () => {
      // The cropped path is a different code path: 768 pads to 1024 for the rotation and
      // the decode renormalizes against the first 768 coordinates only, so the padded
      // measurement above does not cover it.
      //
      // Measured relative L2 here, shipped grid vs a fixed 3-sigma one:
      //   shipped 0.579 0.305 0.156 0.086 0.046 0.026 0.014 0.008
      //   3-sigma 0.579 0.459 0.208 0.100 0.048 0.024 0.012 0.006
      // Note the 3-sigma row is BETTER at 6-8 bits here, so the step assertion alone
      // passes it; the 2- and 3-bit ceilings are what reject it.
      const { relativeL2, magnitudeRatios } = measureRelativeL2(768, 7);

      const ceilings = [0.68, 0.36, 0.185, 0.105, 0.058, 0.033, 0.019, 0.01];
      relativeL2.forEach((value, index) => {
        expect(value).toBeLessThan(ceilings[index]);
      });
      for (let i = 0; i + 1 < relativeL2.length; i++) {
        expect(relativeL2[i + 1]).toBeLessThan(relativeL2[i] * 0.85);
      }
      for (const ratio of magnitudeRatios) expect(ratio).toBeCloseTo(1, 5);
    });

    test("should estimate pairwise similarity more accurately as dimension grows", () => {
      // What concentration of measure actually buys, measured rather than assumed.
      //
      // It does NOT improve single-vector reconstruction: mean reconstruction cosine at
      // 4 bits over 200 seeded draws is 0.99496 at d=64 and 0.99441 at d=256, i.e. very
      // slightly WORSE, and d=256 beat d=64 in only 63 of those 200 draws. The old form
      // of this test asserted "256-dim should be slightly better" in a comment while
      // asserting only `> 0.8` floors on `Math.random()` input, so the false premise
      // never had to hold. Do not reinstate `sim256 > sim64`; it is not true.
      //
      // What does improve, roughly as 1/sqrt(d), is the error of the PAIRWISE similarity
      // estimate — which is what this quantizer exists to serve. Measured RMSE against
      // the exact cosine at 4 bits: 0.0186 (d=64), 0.0101 (d=256), 0.0047 (d=1024).
      const rmseByDimension = [64, 256, 1024].map((d) => {
        const rnd = makeRandom(4000 + d);
        const pairs = 40;
        let squaredError = 0;
        for (let p = 0; p < pairs; p++) {
          const a = new Float32Array(d);
          const b = new Float32Array(d);
          for (let i = 0; i < d; i++) {
            a[i] = rnd() - 0.5;
            b[i] = rnd() - 0.5;
          }
          const error =
            turboQuantizedCosineSimilarity(
              turboQuantize(a, { bits: 4, seed: 42 }),
              turboQuantize(b, { bits: 4, seed: 42 })
            ) - cosineSimilarity(a, b);
          squaredError += error * error;
        }
        return Math.sqrt(squaredError / pairs);
      });

      expect(rmseByDimension[1]).toBeLessThan(rmseByDimension[0] * 0.75);
      expect(rmseByDimension[2]).toBeLessThan(rmseByDimension[1] * 0.75);
      expect(rmseByDimension[2]).toBeLessThan(0.007);
    });
  });

  describe("turboQuantizedInnerProduct", () => {
    test("should estimate inner product of quantized vectors", () => {
      const a = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const b = new Float32Array([8, 7, 6, 5, 4, 3, 2, 1]);

      const trueIP = inner(a, b);
      const qa = turboQuantize(a, { bits: 8, seed: 42 });
      const qb = turboQuantize(b, { bits: 8, seed: 42 });
      const estimatedIP = turboQuantizedInnerProduct(qa, qb);

      // At 8 bits, should be reasonably close
      expect(estimatedIP).toBeCloseTo(trueIP, -1); // within order of magnitude
    });

    test("should estimate inner products accurately at embedding scale", () => {
      // The 8-dim case above is dominated by how poorly a Gaussian-derived clipping range
      // fits 8 bounded coordinates. At a realistic dimensionality the concentration the
      // rotation relies on actually holds, and this is where the loading-factor fix pays:
      // mean absolute error over these pairs measured 0.0566 at a fixed 3-sigma range and
      // 0.0252 at the MSE-optimal one.
      const d = 1024;
      const pairs = 20;
      const rnd = makeRandom(1024);
      let totalError = 0;
      for (let p = 0; p < pairs; p++) {
        const a = new Float32Array(d);
        const b = new Float32Array(d);
        for (let i = 0; i < d; i++) {
          a[i] = rnd() - 0.5;
          b[i] = rnd() - 0.5;
        }
        const estimated = turboQuantizedInnerProduct(
          turboQuantize(a, { bits: 8, seed: 42 }),
          turboQuantize(b, { bits: 8, seed: 42 })
        );
        totalError += Math.abs(estimated - inner(a, b));
      }
      expect(totalError / pairs).toBeLessThan(0.04);
    });

    test("should reject vectors with different dimensions", () => {
      const a = turboQuantize(new Float32Array([1, 2, 3, 4]), { bits: 4, seed: 42 });
      const b = turboQuantize(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]), {
        bits: 4,
        seed: 42,
      });

      expect(() => turboQuantizedInnerProduct(a, b)).toThrow("same dimensions");
    });

    test("should reject vectors with different bit widths", () => {
      const v = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const a = turboQuantize(v, { bits: 4, seed: 42 });
      const b = turboQuantize(v, { bits: 8, seed: 42 });

      expect(() => turboQuantizedInnerProduct(a, b)).toThrow("same bit width");
    });

    test("should reject vectors with different seeds", () => {
      const v = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const a = turboQuantize(v, { bits: 4, seed: 1 });
      const b = turboQuantize(v, { bits: 4, seed: 2 });

      expect(() => turboQuantizedInnerProduct(a, b)).toThrow("same rotation seed");
    });
  });

  describe("turboQuantizedCosineSimilarity", () => {
    test("should estimate cosine similarity between quantized vectors", () => {
      const d = 64;
      const a = new Float32Array(d);
      const b = new Float32Array(d);
      for (let i = 0; i < d; i++) {
        a[i] = Math.sin(i * 0.1);
        b[i] = Math.sin(i * 0.1 + 0.5); // similar but shifted
      }

      const trueSim = cosineSimilarity(a, b);
      const qa = turboQuantize(a, { bits: 8, seed: 42 });
      const qb = turboQuantize(b, { bits: 8, seed: 42 });
      const estimatedSim = turboQuantizedCosineSimilarity(qa, qb);

      // Should be close to true cosine similarity
      expect(Math.abs(estimatedSim - trueSim)).toBeLessThan(0.15);
    });

    test("should return 0 for zero vectors", () => {
      const a = turboQuantize(new Float32Array([0, 0, 0, 0]), { bits: 4, seed: 42 });
      const b = turboQuantize(new Float32Array([1, 2, 3, 4]), { bits: 4, seed: 42 });

      expect(turboQuantizedCosineSimilarity(a, b)).toBe(0);
    });

    test("should give high similarity for identical vectors", () => {
      const v = new Float32Array(64);
      for (let i = 0; i < 64; i++) v[i] = Math.sin(i);

      const qa = turboQuantize(v, { bits: 8, seed: 42 });
      const qb = turboQuantize(v, { bits: 8, seed: 42 });

      expect(turboQuantizedCosineSimilarity(qa, qb)).toBeGreaterThan(0.95);
    });

    test("should track the exact cosine within a per-bit-width RMSE ceiling", () => {
      // This replaces a self-similarity test that could not fail: `quantizedCosine` divides
      // by each side's own `codeNorm`, so comparing a record with itself is 1 by algebra
      // for any grid, any bit width and any input. It measured the identity, not the
      // quantizer. What the quantizer is actually for is estimating the cosine between two
      // DIFFERENT vectors, so that is what is measured here — against the exact cosine of
      // the unquantized inputs, which is the only reference that cannot move with the code
      // under test.
      //
      // Measured RMSE, shipped grid vs a fixed 3-sigma one:
      //   shipped 0.0356 0.0130 0.0070 0.0049 0.0032 0.0013 0.0010 0.0005
      //   3-sigma 0.0356 0.0210 0.0107 0.0058 0.0024 0.0015 0.0008 0.0012
      // The ceilings pass the first row with >=21% headroom and reject the second at 2, 3
      // and 8 bits. The two rows agree exactly at 1 bit because a 2-level grid is +/-a:
      // the codes carry only sign, and the cosine is invariant to the scale of `a`.
      //
      // THE 1-BIT CEILING IS A TRADE, not headroom. It was 0.033 against a measured
      // 0.0273 while the 1-bit estimator returned the raw sign-agreement statistic
      // `1 - 2*theta/pi`. Inverting that to recover the cosine removed a bias of up to
      // 0.21 on correlated pairs (see the signed-bias case below) and cost variance:
      // d/dr of cos(pi*(1 - r)/2) peaks at ~1.57 near theta = pi/2, which is exactly
      // where i.i.d. uniform pairs at d=1024 land, so THIS test's regime pays the
      // amplification in full and gets none of the bias correction. Measured RMSE went
      // 0.0273 -> 0.0356; the ceiling follows to 0.050. Unbiased-but-noisier is the right
      // side of that trade — the noise is symmetric and averages out over a candidate
      // set, and it is worst precisely where the answer is "unrelated" either way, while
      // the bias moved every absolute threshold in one direction.
      const d = 1024;
      const pairs = 24;
      const ceilings = [0.05, 0.016, 0.0085, 0.006, 0.004, 0.0017, 0.0013, 0.0007];

      for (let bits = 1; bits <= 8; bits++) {
        const rnd = makeRandom(2048 + bits);
        let squaredError = 0;
        for (let p = 0; p < pairs; p++) {
          const a = new Float32Array(d);
          const b = new Float32Array(d);
          for (let i = 0; i < d; i++) {
            a[i] = rnd() - 0.5;
            b[i] = rnd() - 0.5;
          }
          const error =
            turboQuantizedCosineSimilarity(
              turboQuantize(a, { bits, seed: 42 }),
              turboQuantize(b, { bits, seed: 42 })
            ) - cosineSimilarity(a, b);
          squaredError += error * error;
        }
        expect(Math.sqrt(squaredError / pairs)).toBeLessThan(ceilings[bits - 1]);
      }
    });

    test("should stay within [-1, 1] across many pairs at every bit width", () => {
      const d = 1024;
      const pairs = 40;
      for (let bits = 1; bits <= 8; bits++) {
        const rnd = makeRandom(1000 + bits);
        for (let p = 0; p < pairs; p++) {
          const a = new Float32Array(d);
          const b = new Float32Array(d);
          for (let i = 0; i < d; i++) {
            a[i] = rnd() - 0.5;
            b[i] = rnd() - 0.5;
          }
          const qa = turboQuantize(a, { bits, seed: 42 });
          const sim = turboQuantizedCosineSimilarity(qa, turboQuantize(b, { bits, seed: 42 }));
          expect(sim).toBeGreaterThanOrEqual(-1);
          expect(sim).toBeLessThanOrEqual(1);
          // Self-similarity belongs here, as one line of the range invariant: dividing by
          // each side's own norm makes it 1 by construction, so it is a statement about
          // the range and not a measurement of quality.
          expect(turboQuantizedCosineSimilarity(qa, qa)).toBeLessThanOrEqual(1);
        }
      }
    });

    /**
     * MEAN SIGNED error on CORRELATED pairs, per (bit width, correlation) cell.
     *
     * Both halves of that sentence are the point.
     *
     * Signed, not RMSE, because RMSE is what every other accuracy case here
     * already measures — and RMSE is exactly what hides a one-directional
     * shrinkage. An estimator that reads every similar pair 0.08 low and an
     * estimator with 0.08 of symmetric noise score the same RMSE; only one of
     * them silently moves a threshold.
     *
     * Correlated, because the existing cases draw both vectors i.i.d. uniform
     * at d=1024, where the true cosine concentrates at 0 ± ~0.03 — the one
     * regime where this bias vanishes. `b = t*a + sqrt(1-t^2)*noise` puts the
     * pair at a chosen similarity instead.
     *
     * The reference is `cosineSimilarity(a, b)` on the UNQUANTIZED inputs,
     * never `t`: `t` is what the construction aims at, and the realized cosine
     * of a finite sample differs from it by ~1/sqrt(d). Scoring against `t`
     * would fold that sampling error into the measured bias.
     *
     * Bands are the MEASURED value ±30%, floored at ±0.005 so a cell whose bias
     * is genuinely at the noise level is not pinned to a number that is itself
     * noise. They are two-sided: an estimator that stopped under-reporting
     * would fail these, which is the intent — this is a record of behavior, not
     * a ceiling. Re-measure and re-record when the estimator changes.
     *
     * What the table shows: shrinkage grows as the bit width falls, and it is
     * an ordinary quantization effect at 2-8 bits (clipping and rounding shrink
     * the reconstructed dot product relative to each side's codeNorm). At 1 bit
     * it is not: a 2-level grid is exactly ±scale, so the estimator degenerates
     * to the sign-agreement statistic 1 - 2*theta/pi, which is a different
     * function of the angle rather than a noisy cosine. That one is invertible,
     * and `quantizedCosine` inverts it — which is why the 1-bit row sits at
     * zero while the 2-bit row, four times finer, is the worst in the table.
     */
    /**
     * The angle correction lives in `quantizedCosine`, so it reaches
     * `turboQuantizedCosineSimilarity` and `turboQuantizedInnerProduct` and NOTHING ELSE.
     * Decoding with `turboDequantize` and running plain `cosineSimilarity` over the
     * results is a different number at 1 bit — lower, by the sign-statistic shrinkage the
     * correction exists to undo.
     *
     * That asymmetry is worth pinning rather than leaving to be discovered: the two
     * routes look interchangeable at every other bit width, and a caller who decodes once
     * and compares many times (the natural optimisation) would silently drop back to the
     * biased estimator at exactly the bit width where the bias is largest.
     */
    test("turboDequantize + plain cosineSimilarity is NOT angle-corrected at 1 bit", () => {
      const d = 1024;
      const rnd = makeRandom(31337);
      const a = new Float32Array(d);
      const noise = new Float32Array(d);
      for (let i = 0; i < d; i++) {
        a[i] = rnd() - 0.5;
        noise[i] = rnd() - 0.5;
      }
      const t = 0.8;
      const k = Math.sqrt(1 - t * t);
      const b = new Float32Array(d);
      for (let i = 0; i < d; i++) b[i] = t * a[i]! + k * noise[i]!;

      const exact = cosineSimilarity(a, b);
      const qa = turboQuantize(a, { bits: 1, seed: 42 });
      const qb = turboQuantize(b, { bits: 1, seed: 42 });

      const corrected = turboQuantizedCosineSimilarity(qa, qb);
      const viaDecode = cosineSimilarity(turboDequantize(qa), turboDequantize(qb));

      // The corrected estimator tracks the exact cosine.
      expect(Math.abs(corrected - exact)).toBeLessThan(0.05);
      // The decode route does not — it is the raw sign statistic, biased low.
      expect(viaDecode).toBeLessThan(exact - 0.1);
      expect(corrected).toBeGreaterThan(viaDecode + 0.1);

      // At 4 bits there is no correction, so the two routes agree closely.
      const wa = turboQuantize(a, { bits: 4, seed: 42 });
      const wb = turboQuantize(b, { bits: 4, seed: 42 });
      expect(
        Math.abs(
          turboQuantizedCosineSimilarity(wa, wb) -
            cosineSimilarity(turboDequantize(wa), turboDequantize(wb))
        )
      ).toBeLessThan(0.01);
    });

    test("should have a per-bit-width, per-correlation signed bias within measured bands", () => {
      const d = 1024;
      const pairs = 32;
      const correlations = [0.5, 0.8, 0.95] as const;

      /** Measured mean signed error, indexed [bits - 1][correlation]. */
      const measured: readonly (readonly number[])[] = [
        [0.0015, 0.0014, -0.0001],
        [-0.0561, -0.0799, -0.075],
        [-0.0171, -0.0271, -0.028],
        [-0.0055, -0.0075, -0.0094],
        [-0.0019, -0.003, -0.003],
        [-0.0001, -0.001, -0.0009],
        [-0.0001, -0.0003, -0.0003],
        [0.0, -0.0001, -0.0001],
      ];

      for (let bits = 1; bits <= 8; bits++) {
        for (let c = 0; c < correlations.length; c++) {
          const t = correlations[c]!;
          const rnd = makeRandom(9000 + bits * 31 + Math.round(t * 100));
          const k = Math.sqrt(1 - t * t);
          let signedError = 0;

          for (let p = 0; p < pairs; p++) {
            const a = new Float32Array(d);
            const noise = new Float32Array(d);
            for (let i = 0; i < d; i++) {
              a[i] = rnd() - 0.5;
              noise[i] = rnd() - 0.5;
            }
            const b = new Float32Array(d);
            for (let i = 0; i < d; i++) b[i] = t * a[i]! + k * noise[i]!;

            signedError +=
              turboQuantizedCosineSimilarity(
                turboQuantize(a, { bits, seed: 42 }),
                turboQuantize(b, { bits, seed: 42 })
              ) - cosineSimilarity(a, b);
          }

          const mean = signedError / pairs;
          const expected = measured[bits - 1]![c]!;
          const tolerance = Math.max(Math.abs(expected) * 0.3, 0.005);
          expect(mean, `bits=${bits} t=${t} mean=${mean.toFixed(5)}`).toBeGreaterThan(
            expected - tolerance
          );
          expect(mean, `bits=${bits} t=${t} mean=${mean.toFixed(5)}`).toBeLessThan(
            expected + tolerance
          );
        }
      }
    });
  });

  describe("sign table cache", () => {
    test("should stay bounded and still reproduce an evicted table exactly", () => {
      // The cache is process-global and keyed by (seed, paddedLen). Eviction has to be
      // transparent: a table is a pure function of its key, so a recomputed one must give
      // byte-identical codes. Twenty distinct seeds overflow the 16-entry bound, so the
      // first seed's table is gone by the end of the loop.
      const d = 4096;
      const vector = new Float32Array(d);
      for (let i = 0; i < d; i++) vector[i] = Math.sin(i * 0.01);

      const first = turboQuantize(vector, { bits: 4, seed: 1 });
      for (let seed = 2; seed <= 20; seed++) {
        expect(() => turboQuantize(vector, { bits: 4, seed })).not.toThrow();
      }

      const afterEviction = turboQuantize(vector, { bits: 4, seed: 1 });
      expect(Array.from(afterEviction.codes)).toEqual(Array.from(first.codes));

      // An explicit clear is likewise result-preserving.
      clearSignTableCache();
      const afterClear = turboQuantize(vector, { bits: 4, seed: 1 });
      expect(Array.from(afterClear.codes)).toEqual(Array.from(first.codes));
    });
  });

  describe("turboQuantizeStorageBytes", () => {
    test("should calculate correct storage for common configurations", () => {
      // 768-dim pads to 1024 (next power of 2):
      // At 4 bits: 1024 * 4 / 8 = 512 bytes
      expect(turboQuantizeStorageBytes(768, 4)).toBe(512);

      // At 2 bits: 1024 * 2 / 8 = 256 bytes
      expect(turboQuantizeStorageBytes(768, 2)).toBe(256);

      // At 8 bits: 1024 * 8 / 8 = 1024 bytes
      expect(turboQuantizeStorageBytes(768, 8)).toBe(1024);

      // At 1 bit: 1024 * 1 / 8 = 128 bytes
      expect(turboQuantizeStorageBytes(768, 1)).toBe(128);

      // Power-of-2 dimension: no extra padding
      // 512-dim at 4 bits: 512 * 4 / 8 = 256 bytes
      expect(turboQuantizeStorageBytes(512, 4)).toBe(256);
    });

    test("should ceil for non-byte-aligned sizes", () => {
      // 3 dimensions pads to 4 (next power of 2), 3 bits: 4 * 3 / 8 = 1.5 -> 2 bytes
      expect(turboQuantizeStorageBytes(3, 3)).toBe(2);
    });

    test("should reject out-of-range dimensions and bits", { timeout: 2000 }, () => {
      // 2^30 + 1 previously spun forever inside the power-of-2 doubling loop
      // (32-bit shift wrap), so a hang must fail the test rather than stall CI.
      expect(() => turboQuantizeStorageBytes(2 ** 30 + 1, 4)).toThrow();
      expect(() => turboQuantizeCompressionRatio(2 ** 30 + 1, 4)).toThrow();

      expect(() => turboQuantizeStorageBytes(0, 4)).toThrow();
      expect(() => turboQuantizeStorageBytes(-5, 4)).toThrow();
      expect(() => turboQuantizeStorageBytes(NaN, 4)).toThrow();
      expect(() => turboQuantizeStorageBytes(1.5, 4)).toThrow();

      expect(() => turboQuantizeStorageBytes(768, 0)).toThrow();
      expect(() => turboQuantizeStorageBytes(768, -5)).toThrow();
      expect(() => turboQuantizeStorageBytes(768, 9)).toThrow();
      expect(() => turboQuantizeStorageBytes(768, NaN)).toThrow();
      expect(() => turboQuantizeCompressionRatio(768, 0)).toThrow();
      expect(() => turboQuantizeCompressionRatio(768, 9)).toThrow();
    });
  });

  describe("turboQuantizeCompressionRatio", () => {
    test("should calculate correct compression ratios", () => {
      // Float32 = 4 bytes/dim.
      // 512-dim (already power-of-2) at 4 bits: ratio = (512 * 4) / (512 * 4 / 8) = 8
      expect(turboQuantizeCompressionRatio(512, 4)).toBe(8);

      // At 2 bits: ratio = (512 * 4) / (512 * 2 / 8) = 16
      expect(turboQuantizeCompressionRatio(512, 2)).toBe(16);

      // At 1 bit: ratio = (512 * 4) / (512 * 1 / 8) = 32
      expect(turboQuantizeCompressionRatio(512, 1)).toBe(32);
    });
  });

  describe("turboQuantizeToTypedArray", () => {
    test("should produce Int8Array for INT8 target", () => {
      const vector = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const result = turboQuantizeToTypedArray(vector, TensorType.INT8);
      expect(result).toBeInstanceOf(Int8Array);
      expect(result.length).toBe(vector.length);
    });

    test("should produce Int16Array for INT16 target", () => {
      const vector = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const result = turboQuantizeToTypedArray(vector, TensorType.INT16);
      expect(result).toBeInstanceOf(Int16Array);
      expect(result.length).toBe(vector.length);
    });

    test("should reject float target types", () => {
      const vector = new Float32Array([1, 2, 3, 4]);
      expect(() => turboQuantizeToTypedArray(vector, TensorType.FLOAT32)).toThrow(
        "signed integer targets only"
      );
      expect(() => turboQuantizeToTypedArray(vector, TensorType.FLOAT64)).toThrow(
        "signed integer targets only"
      );
    });

    test("should reject unsigned target types", () => {
      // An unsigned target needs an affine map with a DC offset, and cosine
      // similarity is not translation-invariant — see the DC-offset test below.
      const vector = new Float32Array([1, 2, 3, 4]);
      expect(() => turboQuantizeToTypedArray(vector, TensorType.UINT8)).toThrow(
        "signed integer targets only"
      );
      expect(() => turboQuantizeToTypedArray(vector, TensorType.UINT16)).toThrow(
        "signed integer targets only"
      );
    });

    test("should reject prototype-chain target type names", () => {
      // A bare `RANGES[targetType]` lookup resolves inherited Object.prototype
      // keys, so a truthy-but-wrong "range" would slip past a `if (!range)` guard.
      const vector = new Float32Array([1, 2, 3, 4]);
      for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        expect(() => turboQuantizeToTypedArray(vector, name as TensorType)).toThrow(
          "signed integer targets only"
        );
      }
    });

    test("should not encode a DC offset (signed output is zero-centred)", () => {
      // Regression guard for the unsigned affine map: it shifted every stored
      // coordinate by the type midpoint, which collapsed cosine similarity for
      // unrelated vectors to ~0.90 and made negative similarities impossible.
      const d = 1024;
      const rnd = makeRandom(42);
      const vector = new Float32Array(d);
      for (let i = 0; i < d; i++) vector[i] = rnd() - 0.5;

      const result = turboQuantizeToTypedArray(vector, TensorType.INT8, 42);

      let sum = 0;
      let negatives = 0;
      for (let i = 0; i < result.length; i++) {
        sum += result[i];
        if (result[i] < 0) negatives++;
      }
      expect(Math.abs(sum / result.length)).toBeLessThan(2);
      expect(negatives / result.length).toBeGreaterThanOrEqual(0.3);
    });

    test("should preserve cosine similarity across power-of-2 dimensions", () => {
      // At a power-of-2 dimensionality the rotation is orthogonal and nothing is
      // discarded, so cosine similarity survives int8 quantization almost exactly.
      const cases: readonly { readonly d: number; readonly rmse: number }[] = [
        { d: 512, rmse: 0.00056 },
        { d: 1024, rmse: 0.00044 },
        { d: 2048, rmse: 0.00026 },
      ];

      for (const { d, rmse } of cases) {
        const rnd = makeRandom(d);
        let squaredError = 0;
        let maxError = 0;
        const pairs = 40;
        for (let p = 0; p < pairs; p++) {
          const a = new Float32Array(d);
          const b = new Float32Array(d);
          for (let i = 0; i < d; i++) {
            a[i] = rnd() - 0.5;
            b[i] = rnd() - 0.5;
          }
          const trueSim = cosineSimilarity(a, b);
          const qa = turboQuantizeToTypedArray(a, TensorType.INT8, 42);
          const qb = turboQuantizeToTypedArray(b, TensorType.INT8, 42);
          const error = Math.abs(cosineSimilarity(qa, qb) - trueSim);
          squaredError += error * error;
          if (error > maxError) maxError = error;
        }
        expect(Math.sqrt(squaredError / pairs)).toBeLessThan(rmse * 1.5);
        expect(maxError).toBeLessThan(0.005);
      }
    });

    test("should reject a non-power-of-2 dimensionality", () => {
      // Keeping the first d of nextPowerOf2(d) rotated coordinates is a lossy random
      // projection that measures WORSE than linear quantization at exactly the sizes
      // real embedding models use, so it is refused rather than silently degraded.
      for (const d of [768, 1000, 1536, 3072]) {
        expect(() => turboQuantizeToTypedArray(new Float32Array(d), TensorType.INT8)).toThrow(
          /power of 2/
        );
      }
    });

    test("should widen to the next power of 2 when padToPowerOf2 is set", () => {
      const padded = turboQuantizeToTypedArray(new Float32Array(768), TensorType.INT8, {
        seed: 42,
        padToPowerOf2: true,
      });
      expect(padded.length).toBe(1024);
      expect(padded).toBeInstanceOf(Int8Array);

      // Already a power of 2: the option is a no-op on length.
      const exact = turboQuantizeToTypedArray(new Float32Array(1024), TensorType.INT8, {
        seed: 42,
        padToPowerOf2: true,
      });
      expect(exact.length).toBe(1024);
    });

    test("should preserve cosine similarity for padded non-power-of-2 vectors", () => {
      // Padding keeps the rotation orthogonal, which is the whole point of preferring it
      // over cropping: at d=768 cropping measured 0.0164 RMSE, padding measures ~0.0003.
      const d = 768;
      const rnd = makeRandom(768);
      let squaredError = 0;
      const pairs = 40;
      for (let p = 0; p < pairs; p++) {
        const a = new Float32Array(d);
        const b = new Float32Array(d);
        for (let i = 0; i < d; i++) {
          a[i] = rnd() - 0.5;
          b[i] = rnd() - 0.5;
        }
        const qa = turboQuantizeToTypedArray(a, TensorType.INT8, { seed: 42, padToPowerOf2: true });
        const qb = turboQuantizeToTypedArray(b, TensorType.INT8, { seed: 42, padToPowerOf2: true });
        const error = Math.abs(cosineSimilarity(qa, qb) - cosineSimilarity(a, b));
        squaredError += error * error;
      }
      expect(Math.sqrt(squaredError / pairs)).toBeLessThan(0.002);
    });

    test("should reject empty vectors", () => {
      expect(() => turboQuantizeToTypedArray(new Float32Array(0), TensorType.INT8)).toThrow();
    });

    test("should be deterministic with same seed", () => {
      const vector = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const r1 = turboQuantizeToTypedArray(vector, TensorType.INT8, 123);
      const r2 = turboQuantizeToTypedArray(vector, TensorType.INT8, 123);
      expect(r1).toEqual(r2);
    });

    test("should produce different results with different seeds", () => {
      const vector = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const r1 = turboQuantizeToTypedArray(vector, TensorType.INT8, 1);
      const r2 = turboQuantizeToTypedArray(vector, TensorType.INT8, 2);
      expect(r1).not.toEqual(r2);
    });

    test("should preserve cosine similarity between vectors (Int8)", () => {
      const d = 128;
      const a = new Float32Array(d);
      const b = new Float32Array(d);
      for (let i = 0; i < d; i++) {
        a[i] = Math.sin(i * 0.1);
        b[i] = Math.sin(i * 0.1 + 0.5);
      }

      const trueSim = cosineSimilarity(a, b);
      const qa = turboQuantizeToTypedArray(a, TensorType.INT8, 42);
      const qb = turboQuantizeToTypedArray(b, TensorType.INT8, 42);
      const quantSim = cosineSimilarity(qa, qb);

      // Turbo Int8 should preserve similarity well
      expect(Math.abs(quantSim - trueSim)).toBeLessThan(0.15);
    });

    test("should preserve cosine similarity between vectors (Int16)", () => {
      const d = 128;
      const a = new Float32Array(d);
      const b = new Float32Array(d);
      for (let i = 0; i < d; i++) {
        a[i] = Math.sin(i * 0.1);
        b[i] = Math.sin(i * 0.1 + 0.5);
      }

      const trueSim = cosineSimilarity(a, b);
      const qa = turboQuantizeToTypedArray(a, TensorType.INT16, 42);
      const qb = turboQuantizeToTypedArray(b, TensorType.INT16, 42);
      const quantSim = cosineSimilarity(qa, qb);

      // Int16 should be very close
      expect(Math.abs(quantSim - trueSim)).toBeLessThan(0.05);
    });

    test("should give high similarity for identical vectors", () => {
      const d = 128;
      const v = new Float32Array(d);
      for (let i = 0; i < d; i++) v[i] = Math.sin(i);

      const qa = turboQuantizeToTypedArray(v, TensorType.INT8, 42);
      const qb = turboQuantizeToTypedArray(v, TensorType.INT8, 42);

      // Identical input + same seed = identical output
      expect(cosineSimilarity(qa, qb)).toBeCloseTo(1, 10);
    });

    test("should handle zero vectors", () => {
      const vector = new Float32Array([0, 0, 0, 0]);

      for (const targetType of [TensorType.INT8, TensorType.INT16] as const) {
        const result = turboQuantizeToTypedArray(vector, targetType);
        expect(result.length).toBe(4);
        for (let i = 0; i < result.length; i++) {
          expect(result[i]).toBe(0);
        }
      }

      expect(() => turboQuantizeToTypedArray(vector, TensorType.UINT8)).toThrow(
        "signed integer targets only"
      );
    });

    test("should produce values within type range for Int8", () => {
      const d = 256;
      const rnd = makeRandom(7);
      const vector = new Float32Array(d);
      for (let i = 0; i < d; i++) vector[i] = rnd() * 10 - 5;

      const result = turboQuantizeToTypedArray(vector, TensorType.INT8);
      for (let i = 0; i < result.length; i++) {
        expect(result[i]).toBeGreaterThanOrEqual(-127);
        expect(result[i]).toBeLessThanOrEqual(127);
      }
    });

    test("should produce values within type range for Int16", () => {
      const d = 256;
      const rnd = makeRandom(11);
      const vector = new Float32Array(d);
      for (let i = 0; i < d; i++) vector[i] = rnd() * 10 - 5;

      const result = turboQuantizeToTypedArray(vector, TensorType.INT16);
      for (let i = 0; i < result.length; i++) {
        expect(result[i]).toBeGreaterThanOrEqual(-32767);
        expect(result[i]).toBeLessThanOrEqual(32767);
      }
    });
  });

  describe("roundtrip quality across bit widths", () => {
    const d = 128;
    const original = new Float32Array(d);
    for (let i = 0; i < d; i++) original[i] = Math.sin(i * 0.1) * (1 + Math.cos(i * 0.05));

    for (const bits of [1, 2, 3, 4, 5, 6, 7, 8]) {
      test(`should maintain reasonable quality at ${bits} bits`, () => {
        const quantized = turboQuantize(original, { bits, seed: 42 });
        const reconstructed = turboDequantize(quantized);
        const sim = cosineSimilarity(original, reconstructed);

        // Quality expectations scale with bits
        if (bits >= 6) {
          expect(sim).toBeGreaterThan(0.95);
        } else if (bits >= 4) {
          expect(sim).toBeGreaterThan(0.85);
        } else if (bits >= 2) {
          expect(sim).toBeGreaterThan(0.5); // Even 2-bit should preserve direction
        } else {
          expect(sim).toBeGreaterThan(0.6); // 1-bit keeps direction via sign information
        }
      });
    }
  });
});
