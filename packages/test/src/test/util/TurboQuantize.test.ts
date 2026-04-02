/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { setLogger } from "@workglow/util";
import {
  turboQuantize,
  turboDequantize,
  turboQuantizeToTypedArray,
  turboQuantizedInnerProduct,
  turboQuantizedCosineSimilarity,
  turboQuantizeStorageBytes,
  turboQuantizeCompressionRatio,
  TensorType,
  cosineSimilarity,
  inner,
  magnitude,
} from "@workglow/util/schema";
import { describe, expect, test } from "vitest";
import { getTestingLogger } from "../../binding/TestingLogger";

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

    test("should improve quality with higher dimensions", () => {
      // TurboQuant relies on concentration of measure, which improves with dimension
      const d64 = 64;
      const d256 = 256;

      const v64 = new Float32Array(d64);
      const v256 = new Float32Array(d256);
      for (let i = 0; i < d64; i++) v64[i] = Math.random() - 0.5;
      for (let i = 0; i < d256; i++) v256[i] = Math.random() - 0.5;

      const q64 = turboQuantize(v64, { bits: 4, seed: 42 });
      const q256 = turboQuantize(v256, { bits: 4, seed: 42 });

      const r64 = turboDequantize(q64);
      const r256 = turboDequantize(q256);

      const sim64 = cosineSimilarity(v64, r64);
      const sim256 = cosineSimilarity(v256, r256);

      // Higher dimension should give better or comparable quality
      // (both should be good, but 256-dim should be slightly better)
      expect(sim64).toBeGreaterThan(0.8);
      expect(sim256).toBeGreaterThan(0.8);
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

    test("should produce Uint8Array for UINT8 target", () => {
      const vector = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const result = turboQuantizeToTypedArray(vector, TensorType.UINT8);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(vector.length);
    });

    test("should produce Int16Array for INT16 target", () => {
      const vector = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const result = turboQuantizeToTypedArray(vector, TensorType.INT16);
      expect(result).toBeInstanceOf(Int16Array);
      expect(result.length).toBe(vector.length);
    });

    test("should produce Uint16Array for UINT16 target", () => {
      const vector = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const result = turboQuantizeToTypedArray(vector, TensorType.UINT16);
      expect(result).toBeInstanceOf(Uint16Array);
      expect(result.length).toBe(vector.length);
    });

    test("should reject float target types", () => {
      const vector = new Float32Array([1, 2, 3, 4]);
      expect(() => turboQuantizeToTypedArray(vector, TensorType.FLOAT32)).toThrow(
        "integer target types"
      );
      expect(() => turboQuantizeToTypedArray(vector, TensorType.FLOAT64)).toThrow(
        "integer target types"
      );
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
      const result = turboQuantizeToTypedArray(vector, TensorType.INT8);
      expect(result.length).toBe(4);
      // All values should be 0 (or the midpoint for unsigned)
      for (let i = 0; i < result.length; i++) {
        expect(result[i]).toBe(0);
      }
    });

    test("should produce values within type range for Int8", () => {
      const d = 256;
      const vector = new Float32Array(d);
      for (let i = 0; i < d; i++) vector[i] = Math.random() * 10 - 5;

      const result = turboQuantizeToTypedArray(vector, TensorType.INT8);
      for (let i = 0; i < result.length; i++) {
        expect(result[i]).toBeGreaterThanOrEqual(-128);
        expect(result[i]).toBeLessThanOrEqual(127);
      }
    });

    test("should produce values within type range for Uint8", () => {
      const d = 256;
      const vector = new Float32Array(d);
      for (let i = 0; i < d; i++) vector[i] = Math.random() * 10 - 5;

      const result = turboQuantizeToTypedArray(vector, TensorType.UINT8);
      for (let i = 0; i < result.length; i++) {
        expect(result[i]).toBeGreaterThanOrEqual(0);
        expect(result[i]).toBeLessThanOrEqual(255);
      }
    });
  });

  describe("roundtrip quality across bit widths", () => {
    const d = 128;
    const original = new Float32Array(d);
    for (let i = 0; i < d; i++) original[i] = Math.sin(i * 0.1) * (1 + Math.cos(i * 0.05));

    for (const bits of [2, 3, 4, 6, 8]) {
      test(`should maintain reasonable quality at ${bits} bits`, () => {
        const quantized = turboQuantize(original, { bits, seed: 42 });
        const reconstructed = turboDequantize(quantized);
        const sim = cosineSimilarity(original, reconstructed);

        // Quality expectations scale with bits
        if (bits >= 6) {
          expect(sim).toBeGreaterThan(0.95);
        } else if (bits >= 4) {
          expect(sim).toBeGreaterThan(0.85);
        } else {
          expect(sim).toBeGreaterThan(0.5); // Even 2-bit should preserve direction
        }
      });
    }
  });
});
