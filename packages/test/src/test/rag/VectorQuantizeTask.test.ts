/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { vectorQuantize } from "@workglow/ai";
import { InMemoryVectorStorage, StorageValidationError } from "@workglow/storage";
import { setLogger } from "@workglow/util";
import type { DataPortSchemaObject } from "@workglow/util/schema";
import { TensorType, TypedArraySchema, turboPaddedLength } from "@workglow/util/schema";
import { getTestingLogger } from "@workglow/util/test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { report, snap } from "../../binding/testTiming";

/**
 * Deterministic PRNG (mulberry32). The accuracy comparisons below assert a ratio between
 * two quantizers, so a `Math.random()` draw would make a real regression and an unlucky
 * sample indistinguishable.
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

/** Exact cosine, used both for the ground truth and for scoring each quantizer's output. */
function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

/**
 * Runs a call expected to be rejected and returns its message, failing loudly if it
 * resolves instead. `rejects.toThrow(/…/)` cannot assert several independent facts about
 * one message without re-running the call once per fact.
 */
async function rejectionMessage(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the call to be rejected, but it resolved");
}

/**
 * The int8 baseline the accuracy tests below score against: divide by the LARGEST
 * ABSOLUTE COORDINATE, then scale to the full [-127, 127] range.
 *
 * Deliberately written here rather than obtained by calling the task's `method: "linear"`
 * path. That path divides by the L2 norm instead and so emits a maximum code of 8 at
 * d=768 — a baseline that has already thrown away three of its eight bits, which is a
 * defect to be repaired separately, not a yardstick. Owning the reference in this file
 * means repairing it cannot move the bounds asserted here.
 */
function maxAbsInt8(v: ArrayLike<number>): Int8Array {
  let largest = 0;
  for (let i = 0; i < v.length; i++) largest = Math.max(largest, Math.abs(v[i]));
  const divisor = largest || 1;
  const out = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Math.round((v[i] / divisor) * 127);
  return out;
}

/** Padded turbo int8 through the task, at the fixed seed both accuracy tests use. */
async function turboOf(v: Float32Array): Promise<Int8Array> {
  const result = await vectorQuantize({
    vector: v,
    targetType: TensorType.INT8,
    method: "turbo",
    turboSeed: 42,
    turboPadToPowerOf2: true,
  });
  return result.vector as Int8Array;
}

/**
 * Minimal vector-store fixtures for the round-trip case below, modelled on the storage
 * package's own `InMemoryVectorStorage` tests. The store is constructed with an explicit
 * dimensionality, which is the whole point here: it is the declared width every write and
 * every query is checked against.
 */
const TurboVecSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    vector: TypedArraySchema(),
    metadata: { type: "object", format: "metadata", additionalProperties: true },
  },
  required: ["id", "vector", "metadata"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

const TurboVecPK = ["id"] as const;

interface TurboVecEntity {
  id: string;
  vector: Int8Array;
  metadata: Record<string, unknown>;
}

function newTurboStore(dimensions: number) {
  return new InMemoryVectorStorage<
    typeof TurboVecSchema,
    typeof TurboVecPK,
    Record<string, unknown>,
    TurboVecEntity
  >(TurboVecSchema, TurboVecPK, [], dimensions);
}

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

  /**
   * The array input predates the turbo work, so this is the one place the branch changes
   * RELEASED behavior — deliberately, and from "silently wrong" to "loud". Such a caller
   * already receives a result whose `originalDimensions` and `originalType` describe only
   * `vectors[0]`, and whose outputs cannot share a storage column, so there is no correct
   * use of the input shape being rejected.
   */
  test("should reject a heterogeneous batch under linear", async () => {
    const vectors = [new Float32Array([0.5, -0.5, 0.8]), new Float32Array([0.1, 0.2, 0.3, 0.4])];

    const message = await rejectionMessage(() =>
      vectorQuantize({ vector: vectors, targetType: TensorType.INT8, normalize: false })
    );

    expect(message).toMatch(/same dimensionality/);
    expect(message).toMatch(/vectors\[1\]/);
    // Method-aware consequence: under linear the outputs keep their lengths, so the break
    // surfaces downstream in cosineSimilarity and in a fixed-width storage column — a
    // different failure from turbo's incomparable bases, and the message says which.
    expect(message).toMatch(/cosineSimilarity/);
    expect(message).toMatch(/storage column/);
  });

  test("should reject a batch of mixed element types", async () => {
    // Same defect on the other metadata field: `originalType` would describe vectors[0]
    // alone, and that is the field a consumer needs to reverse the quantization.
    const vectors = [new Float32Array([1, 2, 3, 4]), new Int8Array([1, 2, 3, 4])];

    const message = await rejectionMessage(() =>
      vectorQuantize({ vector: vectors, targetType: TensorType.INT8, normalize: false })
    );

    expect(message).toMatch(/same element type/);
    expect(message).toMatch(/originalType/);
    expect(message).toMatch(/float32/);
    expect(message).toMatch(/int8/);
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
    test("should return target TypedArray type directly", async () => {
      const vector = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);

      const result = await vectorQuantize({
        vector,
        targetType: TensorType.INT8,
        method: "turbo",
        turboSeed: 42,
      });

      expect(result).toBeDefined();
      expect(result.vector).toBeInstanceOf(Int8Array);
      expect(result.targetType).toBe(TensorType.INT8);
      expect(result.originalType).toBe(TensorType.FLOAT32);
      expect((result.vector as Int8Array).length).toBe(vector.length);
    });

    test("should be deterministic for a fixed seed", async () => {
      const vector = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);

      const r1 = await vectorQuantize({
        vector,
        targetType: TensorType.INT8,
        method: "turbo",
        turboSeed: 99,
      });

      const r2 = await vectorQuantize({
        vector,
        targetType: TensorType.INT8,
        method: "turbo",
        turboSeed: 99,
      });

      const v1 = r1.vector as Int8Array;
      const v2 = r2.vector as Int8Array;
      expect(v1.length).toBe(v2.length);
      for (let i = 0; i < v1.length; i++) {
        expect(v1[i]).toBe(v2[i]);
      }
    });

    test("should handle array of vectors with turbo method", async () => {
      const vectors = [new Float32Array([1, 2, 3, 4]), new Float32Array([5, 6, 7, 8])];

      const result = await vectorQuantize({
        vector: vectors,
        targetType: TensorType.INT8,
        method: "turbo",
        turboSeed: 42,
      });

      expect(Array.isArray(result.vector)).toBe(true);
      const out = result.vector as Int8Array[];
      expect(out.length).toBe(2);
      out.forEach((v) => expect(v).toBeInstanceOf(Int8Array));
      expect(result.targetType).toBe(TensorType.INT8);
    });

    test("should reject unsigned targetType for turbo", async () => {
      const vector = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);

      for (const targetType of [TensorType.UINT8, TensorType.UINT16] as const) {
        await expect(
          vectorQuantize({ vector, targetType, method: "turbo", turboSeed: 42 })
        ).rejects.toThrow();
      }
    });

    test("should reject a non-power-of-2 dimensionality with an actionable message", async () => {
      // 768 is MiniLM's dimensionality, so this is the common case rather than an edge
      // one. Turbo rotates in 1024 dimensions, so it either widens the output or discards
      // 256 coordinates; the task offers only the first, behind an explicit opt-in.
      const vector = new Float32Array(768);
      for (let i = 0; i < 768; i++) vector[i] = Math.sin(i * 0.1);

      const rejection = async (): Promise<Error> => {
        try {
          await vectorQuantize({
            vector,
            targetType: TensorType.INT8,
            method: "turbo",
            turboSeed: 42,
          });
        } catch (error) {
          return error as Error;
        }
        throw new Error("expected turbo at d=768 to be rejected");
      };
      const message = (await rejection()).message;

      expect(message).toMatch(/768/);
      expect(message).toMatch(/1024/);
      // The padding opt-in has to be named, and named first: it is the accurate remedy,
      // and a user cannot discover an input the message does not mention.
      expect(message).toMatch(/turboPadToPowerOf2/);
      expect(message).toMatch(/linear/);

      // The stale figure the message used to quote is the CROPPED variant's RMSE, which
      // this code path no longer emits. Quoting it steered users to `linear` on a
      // comparison that does not describe either option now on offer.
      expect(message).not.toContain("0.0164");

      // The message must name the honest baseline, not just this task's own linear path.
      // Comparing only against `method: "linear"` reads as an 8x win for turbo, but that
      // path emits a maximum code of 8 of 127 at d=768 — so the gap measures its scaling
      // defect, not the rotation. A reader deciding between the two needs the max-abs
      // comparison, where turbo is the slightly WORSE option on well-conditioned input.
      expect(message).toMatch(/max\|v\||max-abs/);
      expect(message).toMatch(/WORSE/);
      expect(message).toMatch(/outlier/);

      // The same vector is fine under linear quantization.
      const linear = await vectorQuantize({ vector, targetType: TensorType.INT8 });
      expect((linear.vector as Int8Array).length).toBe(768);
    });

    test("should widen to the next power of 2 when turboPadToPowerOf2 is set", async () => {
      const vector = new Float32Array(768);
      for (let i = 0; i < 768; i++) vector[i] = Math.sin(i * 0.1);

      const result = await vectorQuantize({
        vector,
        targetType: TensorType.INT8,
        method: "turbo",
        turboSeed: 42,
        turboPadToPowerOf2: true,
      });

      const out = result.vector as Int8Array;
      expect(out).toBeInstanceOf(Int8Array);
      // The output is LONGER than the input. That is the whole reason the flag defaults
      // to false: a storage column declared at 768 would reject this vector.
      expect(out.length).toBe(1024);
      expect(result.method).toBe("turbo");
      expect(result.turboSeed).toBe(42);
    });

    test("should match a max-abs int8 baseline on similarity error at d=768 when padded", async () => {
      // The measurement behind the rejection message and the schema description, asserted
      // rather than quoted.
      //
      // The reference is a max-abs int8 quantizer written HERE, deliberately, and it is
      // not `linearRmse / 4` and not this task's own linear path at any ratio. That path
      // divides by the vector's L2 norm before scaling by 127, which on a well-spread
      // d=768 vector leaves every coordinate near 1/sqrt(768) — so the largest code it
      // ever emits is 8 of a possible 127, and three of its eight bits are gone before
      // any comparison happens. Beating it by 8x measured that defect, not the rotation.
      // Worse, it was a test pinned to the wrong thing: repairing `quantizeToInt8` to
      // divide by max|v| would have turned this assertion red for exactly the right
      // reason. Computing the reference in this file means the bound cannot move when
      // that repair lands.
      //
      // On this generator turbo is legitimately the WORSE of the two, and the assertion
      // says so. I.i.d. uniform coordinates are the best possible case for max-abs: no
      // coordinate is an outlier, so the divisor is representative and the full code
      // range is used. Measured 0.00034 (turbo) vs 0.00024 (max-abs) — a 1.4x deficit.
      // The bound admits that and pins the magnitude, so a real regression in either
      // direction still fails. The case where turbo wins is the next test.
      const d = 768;
      const pairs = 40;
      const rnd = makeRandom(d);

      let turboSquaredError = 0;
      let maxAbsSquaredError = 0;
      for (let p = 0; p < pairs; p++) {
        const a = new Float32Array(d);
        const b = new Float32Array(d);
        for (let i = 0; i < d; i++) {
          a[i] = rnd() - 0.5;
          b[i] = rnd() - 0.5;
        }
        const exact = cosine(a, b);

        const turboError = cosine(await turboOf(a), await turboOf(b)) - exact;
        turboSquaredError += turboError * turboError;
        const maxAbsError = cosine(maxAbsInt8(a), maxAbsInt8(b)) - exact;
        maxAbsSquaredError += maxAbsError * maxAbsError;
      }

      const turboRmse = Math.sqrt(turboSquaredError / pairs);
      const maxAbsRmse = Math.sqrt(maxAbsSquaredError / pairs);

      // Turbo stays in its distribution-invariant band whatever the input is.
      expect(turboRmse).toBeLessThan(0.001);
      // ...and is within 2x of the baseline even where the baseline is at its strongest.
      // Measured ratio is 1.4x; 2x leaves headroom for an unrelated tweak without
      // admitting a real collapse.
      expect(turboRmse).toBeLessThan(maxAbsRmse * 2);
    });

    test("should beat a max-abs int8 baseline when the input carries outlier dimensions", async () => {
      // This is the claim the rejection message and the schema description now make, and
      // the reason padded turbo is worth offering at all: its error is roughly invariant
      // to the input distribution, because the rotation gives every coordinate the same
      // marginal before the grid is applied.
      //
      // Max-abs has no such property. Its divisor is a single order statistic, so one
      // outlier dimension sets it for the whole vector and crushes every ordinary
      // coordinate toward zero — real embedding models exhibit exactly this ("massive
      // activations"), which is why the benign case above is not the case that decides
      // the recommendation. Gaussian coordinates with 2 dimensions at 20x: measured
      // turbo 0.00039 vs max-abs 0.00174, a 4.5x advantage the other way.
      //
      // Together with the previous test this pins BOTH halves of the wording, so the
      // corrected claims cannot silently rot: one test fails if turbo is ever presented
      // as dramatically better in the benign case, the other if it stops being better in
      // the heavy-tailed one.
      const d = 768;
      const pairs = 40;
      const rnd = makeRandom(d);
      // Box-Muller off the same seeded PRNG: heavy-tailed inputs must be as reproducible
      // as the uniform ones, or an unlucky draw is indistinguishable from a regression.
      const gaussian = (): number =>
        Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12))) * Math.cos(2 * Math.PI * rnd());

      let turboSquaredError = 0;
      let maxAbsSquaredError = 0;
      for (let p = 0; p < pairs; p++) {
        const a = new Float32Array(d);
        const b = new Float32Array(d);
        for (let i = 0; i < d; i++) {
          a[i] = gaussian();
          b[i] = gaussian();
        }
        // Two "massive activation" dimensions, the shape that defeats a max-abs divisor.
        a[0] *= 20;
        a[1] *= 20;
        b[0] *= 20;
        b[1] *= 20;
        const exact = cosine(a, b);

        const turboError = cosine(await turboOf(a), await turboOf(b)) - exact;
        turboSquaredError += turboError * turboError;
        const maxAbsError = cosine(maxAbsInt8(a), maxAbsInt8(b)) - exact;
        maxAbsSquaredError += maxAbsError * maxAbsError;
      }

      const turboRmse = Math.sqrt(turboSquaredError / pairs);
      const maxAbsRmse = Math.sqrt(maxAbsSquaredError / pairs);

      // Measured 4.5x; asserting 3x leaves headroom without admitting a reversal.
      expect(turboRmse).toBeLessThan(maxAbsRmse / 3);
    });

    test("records the shipped linear int8 path's largest emitted code at d=768", async () => {
      // RECORDED DEFECT, NOT A DESIRED PROPERTY.
      //
      // `VectorQuantizeTask.quantizeToInt8` divides by the vector's L2 norm and then
      // scales by 127. On a well-spread d=768 vector every coordinate is near 1/sqrt(768),
      // so the largest code the path can emit is 8 — it uses 4 of the 255 available
      // codes and discards three of its eight bits. That is a pre-existing defect
      // unrelated to TurboQuant, and it is deliberately NOT fixed here: the divisor
      // change rescales every stored coordinate ~16x at this width, which cosine survives
      // (a positive scalar multiple) but `l2` and `ip` do not, and nothing marks a stored
      // int8 vector with the scaling that produced it.
      //
      // This assertion exists so that repair is a deliberate, reviewed change rather than
      // a surprise. When `quantizeToInt8` is repaired to divide by max|v|, this
      // expectation changes to 127 and this comment goes away.
      const d = 768;
      const rnd = makeRandom(d);
      const v = new Float32Array(d);
      for (let i = 0; i < d; i++) v[i] = rnd() - 0.5;

      const linear = (await vectorQuantize({ vector: v, targetType: TensorType.INT8 }))
        .vector as Int8Array;

      let largest = 0;
      for (const code of linear) largest = Math.max(largest, Math.abs(code));
      expect(largest).toBe(8);
    });

    test("should report originalDimensions alongside a widened turbo vector", async () => {
      // The output length alone cannot distinguish a 768-dim model widened to 1024 from a
      // model that genuinely emits 1024 dimensions; `originalDimensions` is what does.
      const vector = new Float32Array(768);
      for (let i = 0; i < 768; i++) vector[i] = Math.sin(i * 0.1);

      const padded = await vectorQuantize({
        vector,
        targetType: TensorType.INT8,
        method: "turbo",
        turboPadToPowerOf2: true,
      });
      expect((padded.vector as Int8Array).length).toBe(1024);
      expect(padded.originalDimensions).toBe(768);

      // Unwidened paths report the input length, which equals the output length.
      const linear = await vectorQuantize({ vector, targetType: TensorType.INT8 });
      expect(linear.originalDimensions).toBe(768);
    });

    test("should report method and turboSeed on the output", async () => {
      const vector = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);

      const turbo = await vectorQuantize({
        vector,
        targetType: TensorType.INT8,
        method: "turbo",
        turboSeed: 99,
      });
      expect(turbo.method).toBe("turbo");
      expect(turbo.turboSeed).toBe(99);

      const linear = await vectorQuantize({ vector, targetType: TensorType.INT8 });
      expect(linear.method).toBe("linear");
      expect(linear.turboSeed).toBeUndefined();
    });

    /**
     * The power-of-2 check asks a PER-VECTOR question about a BATCH-level invariant, so a
     * batch of two different power-of-2 lengths passed it and resolved: each vector was
     * rotated in its own padded length, under `getSignTable(seed, paddedLen)` — a
     * different basis per length — while `originalDimensions` reported only 512.
     */
    test("should reject a heterogeneous batch under turbo", async () => {
      const vectors = [new Float32Array(512), new Float32Array(1024)];
      for (let i = 0; i < 512; i++) vectors[0]![i] = Math.sin(i * 0.1);
      for (let i = 0; i < 1024; i++) vectors[1]![i] = Math.cos(i * 0.1);

      const message = await rejectionMessage(() =>
        vectorQuantize({
          vector: vectors,
          targetType: TensorType.INT8,
          method: "turbo",
          turboSeed: 42,
        })
      );

      expect(message).toMatch(/512/);
      expect(message).toMatch(/1024/);
      // The index is what makes a 500-vector batch actionable.
      expect(message).toMatch(/vectors\[1\]/);
      expect(message).toMatch(/separate call/);
    });

    /**
     * The leg that proves the guard is not the existing power-of-2 check under another
     * name: with padding on, 700 and 1100 both pass that check and are simply rotated in
     * 1024 and 2048. Before this guard the call resolved with `originalDimensions: 700`.
     */
    test("should reject a heterogeneous batch under turbo even with padding enabled", async () => {
      const vectors = [new Float32Array(700), new Float32Array(1100)];
      for (let i = 0; i < 700; i++) vectors[0]![i] = Math.sin(i * 0.1);
      for (let i = 0; i < 1100; i++) vectors[1]![i] = Math.cos(i * 0.1);

      const message = await rejectionMessage(() =>
        vectorQuantize({
          vector: vectors,
          targetType: TensorType.INT8,
          method: "turbo",
          turboSeed: 42,
          turboPadToPowerOf2: true,
        })
      );

      expect(message).toMatch(/700/);
      expect(message).toMatch(/1100/);
      // The padded widths are the point: they are what differ in the basis, and they are
      // not visible from the input lengths.
      expect(message).toMatch(/1024/);
      expect(message).toMatch(/2048/);
    });

    test("should reject an empty batch by naming the input", async () => {
      // Previously reached `getVectorType(undefined)` and threw "Unknown vector type:
      // undefined", which names neither the input nor the shape of the mistake.
      const message = await rejectionMessage(() =>
        vectorQuantize({
          vector: [],
          targetType: TensorType.INT8,
          method: "turbo",
          turboSeed: 42,
        })
      );

      expect(message).toMatch(/empty array/);
      expect(message).not.toMatch(/Unknown vector type/);
    });

    /**
     * The regression guard for the two commits above: a HOMOGENEOUS batch is the shape the
     * guard must leave untouched, so the existing case is re-asserted here explicitly
     * rather than assumed to still hold.
     */
    test("should still accept a homogeneous turbo batch", async () => {
      const vectors = [new Float32Array([1, 2, 3, 4]), new Float32Array([5, 6, 7, 8])];

      const result = await vectorQuantize({
        vector: vectors,
        targetType: TensorType.INT8,
        method: "turbo",
        turboSeed: 42,
      });

      const out = result.vector as Int8Array[];
      expect(out.length).toBe(2);
      out.forEach((v) => expect(v.length).toBe(4));
      expect(result.originalDimensions).toBe(4);
    });

    /**
     * THE CLAIM THE MODULE DOC MAKES IN PROSE, EXECUTED.
     *
     * `TurboQuantize.ts`'s module doc says the typed-array encoder's output "drops into any
     * backend that declares a fixed-width column at the output's length (mind that
     * `padToPowerOf2` makes that length longer than the input's — declare the column at the
     * padded width)". Nothing anywhere runs that. Three separate things are asserted only
     * in prose, and each of them fails silently if it regresses:
     *
     * - that `turboQuantizeToTypedArray`'s output is a shape `assertVectorShape` accepts
     *   entry by entry — an `Int8Array` of finite numbers, not a record and not a packed
     *   buffer (the packed `turboQuantize` codec deliberately cannot go into a store at
     *   all, so this is the ONLY turbo encoder with a storage path);
     * - that the length is `turboPaddedLength(d)` and NOT `d`, end to end — through the
     *   task, through `putBulk`'s validation, and back out of `similaritySearch`; and
     * - that a padded vector still retrieves its neighbour, so a regression that cropped
     *   back to `d` or re-padded a second time would be caught by more than a length check.
     *
     * Every other turbo test in this file stops at the task's return value. A regression
     * that silently cropped or re-padded, or an `assertVectorShape` change that stopped
     * accepting `Int8Array`, is invisible to all of them.
     *
     * The corpus is kept to ~25 vectors because each one is a full workflow run, and it
     * reuses `turboOf` rather than building a second quantization path — the point is that
     * what the TASK emits is storable, not what a hand-rolled encoder emits.
     */
    describe("IVectorStorage round trip", () => {
      const d = 768;
      const paddedD = turboPaddedLength(d); // 1024

      /** Query plus 24 background vectors and one planted neighbour at true cosine ~0.85. */
      function makeCorpus(): {
        query: Float32Array;
        planted: Float32Array;
        background: Float32Array[];
      } {
        const rnd = makeRandom(9001);
        const query = new Float32Array(d);
        for (let i = 0; i < d; i++) query[i] = rnd() - 0.5;

        const background: Float32Array[] = [];
        for (let n = 0; n < 24; n++) {
          const v = new Float32Array(d);
          for (let i = 0; i < d; i++) v[i] = rnd() - 0.5;
          background.push(v);
        }

        // `t * query + sqrt(1 - t^2) * noise` — a vector at planted cosine `t`.
        const t = 0.85;
        const k = Math.sqrt(1 - t * t);
        const noise = new Float32Array(d);
        for (let i = 0; i < d; i++) noise[i] = rnd() - 0.5;
        const planted = new Float32Array(d);
        for (let i = 0; i < d; i++) planted[i] = t * query[i]! + k * noise[i]!;

        return { query, planted, background };
      }

      test("a padded turbo vector round-trips through a store declared at turboPaddedLength(d)", async () => {
        const { query, planted, background } = makeCorpus();
        const store = newTurboStore(paddedD);

        // The width contract as an assertion rather than a comment: the store is 1024 wide
        // for a 768-dimensional embedding, and that gap IS the thing being pinned.
        expect(store.getVectorDimensions()).toBe(paddedD);
        expect(store.getVectorDimensions()).not.toBe(d);

        const rows: TurboVecEntity[] = [];
        for (let n = 0; n < background.length; n++) {
          rows.push({ id: `bg-${n}`, vector: await turboOf(background[n]!), metadata: {} });
        }
        rows.push({ id: "planted", vector: await turboOf(planted), metadata: {} });

        // `putBulk` is what runs `validateVectorEntities`, so this write is the check that
        // the task's output passes `assertVectorShape` entry by entry.
        await store.putBulk(rows);

        // `scoreThreshold: -1` so nothing is filtered out by score and the ranking itself
        // is what the assertions read.
        const results = await store.similaritySearch(await turboOf(query), {
          topK: 5,
          scoreThreshold: -1,
        });

        expect(results[0]!.id).toBe("planted");
        expect(results[0]!.vector).toBeInstanceOf(Int8Array);
        expect(results[0]!.vector.length).toBe(paddedD);

        // The score is a quantized estimate of the exact cosine of the UNQUANTIZED pair,
        // which is the only reference that cannot move with the code under test.
        expect(results[0]!.score).toBeCloseTo(cosine(query, planted), 1.5);
        expect(Math.abs(results[0]!.score - cosine(query, planted))).toBeLessThan(0.03);
      });

      /**
       * THE FOOTGUN, EXECUTED.
       *
       * Four separate error messages in this codebase warn that padding widens the output
       * and that a fixed-width column must be declared at the padded width —
       * `TurboQuantize.ts`'s `padToPowerOf2` docs and its typed-array encoder's throw,
       * `VectorQuantizeTask`'s `turboPadToPowerOf2` schema description and its own
       * non-power-of-2 rejection. This is the only place the CONSEQUENCE of ignoring them
       * is actually run: the write is refused by the store, not by turbo.
       *
       * That is also why `turboPadToPowerOf2` defaults to `false` — widening the output is
       * an explicit choice precisely because the store that receives it has to be sized for
       * it, and there is no way for the task to know how the caller's column is declared.
       */
      test("a store declared at d rejects the widened turbo vector on write", async () => {
        const { planted } = makeCorpus();
        const store = newTurboStore(d);
        const row = { id: "planted", vector: await turboOf(planted), metadata: {} };

        expect(row.vector.length).toBe(paddedD);
        await expect(store.putBulk([row])).rejects.toThrow(
          /Vector dimension mismatch on write: expected 768, got 1024/
        );
        await expect(store.putBulk([row])).rejects.toBeInstanceOf(StorageValidationError);
      });
    });
  });
});
