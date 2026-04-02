/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { vectorQuantize } from "@workglow/ai";
import { setLogger } from "@workglow/util";
import { TensorType } from "@workglow/util/schema";
import { getTestingLogger } from "@workglow/util/test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { report, snap } from "../../binding/testTiming";

let _snap = snap();
beforeEach(() => {
  _snap = snap();
});
afterEach(() => {
  report("vec-quantize", _snap);
});

describe("VectorQuantizeTask", () => {
  let logger = getTestingLogger();
  setLogger(logger);
  const testVector = new Float32Array([0.5, -0.5, 0.8, -0.3, 0.0, 1.0, -1.0]);

  test("should quantize to INT8", async () => {
    const result = await vectorQuantize({
      vector: testVector,
      targetType: TensorType.INT8,
      normalize: false,
    });

    expect(result).toBeDefined();
    expect(result.vector).toBeInstanceOf(Int8Array);
    expect(result.originalType).toBe(TensorType.FLOAT32);
    expect(result.targetType).toBe(TensorType.INT8);

    const quantized = result.vector as Int8Array;
    expect(quantized.length).toBe(testVector.length);
    // Values should be scaled to [-127, 127]
    expect(quantized[0]).toBe(64); // 0.5 * 127 ≈ 64
    expect(quantized[1]).toBe(-63); // -0.5 * 127 ≈ -63 (rounded)
  });

  test("should quantize to UINT8", async () => {
    const result = await vectorQuantize({
      vector: testVector,
      targetType: TensorType.UINT8,
      normalize: false,
    });

    expect(result).toBeDefined();
    expect(result.vector).toBeInstanceOf(Uint8Array);
    expect(result.targetType).toBe(TensorType.UINT8);

    const quantized = result.vector as Uint8Array;
    expect(quantized.length).toBe(testVector.length);
    // Values should be scaled to [0, 255]
    expect(quantized.every((v) => v >= 0 && v <= 255)).toBe(true);
  });

  test("should quantize to INT16", async () => {
    const result = await vectorQuantize({
      vector: testVector,
      targetType: TensorType.INT16,
      normalize: false,
    });

    expect(result).toBeDefined();
    expect(result.vector).toBeInstanceOf(Int16Array);
    expect(result.targetType).toBe(TensorType.INT16);

    const quantized = result.vector as Int16Array;
    expect(quantized.length).toBe(testVector.length);
    // Values should be scaled to [-32767, 32767]
    expect(quantized[0]).toBeCloseTo(16384, -2); // 0.5 * 32767
  });

  test("should quantize to UINT16", async () => {
    const result = await vectorQuantize({
      vector: testVector,
      targetType: TensorType.UINT16,
      normalize: false,
    });

    expect(result).toBeDefined();
    expect(result.vector).toBeInstanceOf(Uint16Array);
    expect(result.targetType).toBe(TensorType.UINT16);

    const quantized = result.vector as Uint16Array;
    expect(quantized.length).toBe(testVector.length);
    // Values should be scaled to [0, 65535]
    expect(quantized.every((v) => v >= 0 && v <= 65535)).toBe(true);
  });

  test("should quantize to FLOAT16", async () => {
    const result = await vectorQuantize({
      vector: testVector,
      targetType: TensorType.FLOAT16,
      normalize: false,
    });

    expect(result).toBeDefined();
    expect(result.vector).toBeInstanceOf(Float16Array);
    expect(result.targetType).toBe(TensorType.FLOAT16);

    const quantized = result.vector as Float16Array;
    expect(quantized.length).toBe(testVector.length);
  });

  test("should quantize to FLOAT64", async () => {
    const result = await vectorQuantize({
      vector: testVector,
      targetType: TensorType.FLOAT64,
      normalize: false,
    });

    expect(result).toBeDefined();
    expect(result.vector).toBeInstanceOf(Float64Array);
    expect(result.targetType).toBe(TensorType.FLOAT64);

    const quantized = result.vector as Float64Array;
    expect(quantized.length).toBe(testVector.length);
  });

  test("should handle normalization", async () => {
    const unnormalizedVector = new Float32Array([1, 2, 3, 4, 5]);

    const result = await vectorQuantize({
      vector: unnormalizedVector,
      targetType: TensorType.INT8,
      normalize: true,
    });

    expect(result).toBeDefined();
    expect(result.vector).toBeInstanceOf(Int8Array);

    // With normalization, values should be normalized before quantization
    const quantized = result.vector as Int8Array;
    expect(quantized.length).toBe(unnormalizedVector.length);
  });

  test("should handle array of vectors", async () => {
    const vectors = [
      new Float32Array([0.5, -0.5, 0.8]),
      new Float32Array([0.1, 0.2, 0.3]),
      new Float32Array([-0.4, -0.5, -0.6]),
    ];

    const result = await vectorQuantize({
      vector: vectors,
      targetType: TensorType.INT8,
      normalize: false,
    });

    expect(result).toBeDefined();
    expect(Array.isArray(result.vector)).toBe(true);

    const quantizedVectors = result.vector as Int8Array[];
    expect(quantizedVectors.length).toBe(3);
    quantizedVectors.forEach((v, idx) => {
      expect(v).toBeInstanceOf(Int8Array);
      expect(v.length).toBe(vectors[idx].length);
    });
  });

  test("should preserve dimensions when quantizing", async () => {
    const largeVector = new Float32Array(384).map(() => Math.random() * 2 - 1);

    const result = await vectorQuantize({
      vector: largeVector,
      targetType: TensorType.INT8,
      normalize: true,
    });

    expect(result).toBeDefined();
    const quantized = result.vector as Int8Array;
    expect(quantized.length).toBe(largeVector.length);
  });

  test("should handle edge cases in INT8 quantization", async () => {
    const edgeVector = new Float32Array([1.0, -1.0, 1.5, -1.5, 0.0]);

    const result = await vectorQuantize({
      vector: edgeVector,
      targetType: TensorType.INT8,
      normalize: false,
    });

    const quantized = result.vector as Int8Array;
    // Values clamped to [-1, 1] before scaling
    expect(quantized[0]).toBe(127); // 1.0 * 127
    expect(quantized[1]).toBe(-127); // -1.0 * 127
    expect(quantized[2]).toBe(127); // 1.5 clamped to 1.0
    expect(quantized[3]).toBe(-127); // -1.5 clamped to -1.0
    expect(quantized[4]).toBe(0); // 0.0
  });

  test("should detect original vector type", async () => {
    const int8Vector = new Int8Array([10, 20, 30, 40]);

    const result = await vectorQuantize({
      vector: int8Vector,
      targetType: TensorType.FLOAT32,
      normalize: false,
    });

    expect(result.originalType).toBe(TensorType.INT8);
    expect(result.targetType).toBe(TensorType.FLOAT32);
    expect(result.vector).toBeInstanceOf(Float32Array);
  });

  test("should handle different typed arrays as input", async () => {
    const testCases = [
      { input: new Float16Array([0.5, -0.5]), expected: TensorType.FLOAT16 },
      { input: new Float32Array([0.5, -0.5]), expected: TensorType.FLOAT32 },
      { input: new Float64Array([0.5, -0.5]), expected: TensorType.FLOAT64 },
      { input: new Int8Array([10, -10]), expected: TensorType.INT8 },
      { input: new Uint8Array([10, 20]), expected: TensorType.UINT8 },
      { input: new Int16Array([100, -100]), expected: TensorType.INT16 },
      { input: new Uint16Array([100, 200]), expected: TensorType.UINT16 },
    ];

    for (const testCase of testCases) {
      const result = await vectorQuantize({
        vector: testCase.input,
        targetType: TensorType.FLOAT32,
        normalize: false,
      });
      expect(result.originalType).toBe(testCase.expected);
    }
  });

  test("should use default normalize value of true", async () => {
    const result = await vectorQuantize({ vector: testVector, targetType: TensorType.INT8 });

    expect(result).toBeDefined();
    expect(result.vector).toBeInstanceOf(Int8Array);
  });

  describe("turbo method", () => {
    test("should return Float32Array and report targetType as FLOAT32", async () => {
      const vector = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);

      const result = await vectorQuantize({
        vector,
        targetType: TensorType.INT8,
        method: "turbo",
        turboBits: 4,
        turboSeed: 42,
      });

      expect(result).toBeDefined();
      expect(result.vector).toBeInstanceOf(Float32Array);
      // targetType must reflect the actual output, not the requested type
      expect(result.targetType).toBe(TensorType.FLOAT32);
      expect(result.originalType).toBe(TensorType.FLOAT32);
      expect((result.vector as Float32Array).length).toBe(vector.length);
    });

    test("should be deterministic for a fixed seed", async () => {
      const vector = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);

      const r1 = await vectorQuantize({
        vector,
        targetType: TensorType.FLOAT32,
        method: "turbo",
        turboBits: 4,
        turboSeed: 99,
      });

      const r2 = await vectorQuantize({
        vector,
        targetType: TensorType.FLOAT32,
        method: "turbo",
        turboBits: 4,
        turboSeed: 99,
      });

      const v1 = r1.vector as Float32Array;
      const v2 = r2.vector as Float32Array;
      expect(v1.length).toBe(v2.length);
      for (let i = 0; i < v1.length; i++) {
        expect(v1[i]).toBe(v2[i]);
      }
    });

    test("should handle array of vectors with turbo method", async () => {
      const vectors = [
        new Float32Array([1, 2, 3, 4]),
        new Float32Array([5, 6, 7, 8]),
      ];

      const result = await vectorQuantize({
        vector: vectors,
        targetType: TensorType.INT8,
        method: "turbo",
        turboBits: 4,
        turboSeed: 42,
      });

      expect(Array.isArray(result.vector)).toBe(true);
      const out = result.vector as Float32Array[];
      expect(out.length).toBe(2);
      out.forEach((v) => expect(v).toBeInstanceOf(Float32Array));
      expect(result.targetType).toBe(TensorType.FLOAT32);
    });
  });
});
