/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IRunConfig, TaskConfig } from "@workglow/task-graph";
import { CreateWorkflow, Task, Workflow } from "@workglow/task-graph";
import type { DataPortSchema, TypedArray } from "@workglow/util/schema";
import {
  DEFAULT_SEED,
  normalizeNumberArray,
  TensorType,
  turboPaddedLength,
  turboQuantizeToTypedArray,
  TypedArraySchema,
} from "@workglow/util/schema";
import type { Capability } from "../capability/Capabilities";

export const QuantizationMethod = {
  LINEAR: "linear",
  TURBO: "turbo",
} as const;

export type QuantizationMethod = (typeof QuantizationMethod)[keyof typeof QuantizationMethod];

const inputSchema = {
  type: "object",
  properties: {
    vector: {
      anyOf: [
        TypedArraySchema({
          title: "Vector",
          description: "The vector to quantize",
        }),
        {
          type: "array",
          items: TypedArraySchema({
            title: "Vector",
            description: "Vector to quantize",
          }),
        },
      ],
      title: "Input Vector(s)",
      description: "Vector or array of vectors to quantize",
    },
    targetType: {
      type: "string",
      enum: Object.values(TensorType),
      title: "Target Type",
      description: "Target quantization type",
      default: TensorType.INT8,
    },
    normalize: {
      type: "boolean",
      title: "Normalize",
      description:
        "Normalize vector before quantization. Ignored for method 'turbo', which always L2-normalizes internally.",
      default: true,
    },
    method: {
      type: "string",
      enum: Object.values(QuantizationMethod),
      title: "Method",
      description:
        "Quantization method: 'linear' for simple min-max scaling, 'turbo' for TurboQuant (randomized Hadamard rotation + uniform scalar quantization at the MSE-optimal Gaussian clipping range). The name refers to the borrowed randomized-rotation strategy from arXiv:2504.19874, not to that paper's quantizer: level placement here is uniform, and the paper's distribution-fitted (Beta) placement — the contribution that buys its near-optimal distortion rate — is not implemented, so distortion is that of an optimal uniform quantizer. Turbo requires a signed integer targetType (int8 or int16). It rotates in turboPaddedLength(d) dimensions, so a non-power-of-2 input needs turboPadToPowerOf2: true, which widens the output to turboPaddedLength(d); without it such an input is rejected rather than silently degraded. Accuracy, as measured int8 cosine RMSE over 40 seeded pairs at d=768: padded turbo 0.00034, a max-abs int8 quantizer 0.00024, this task's own linear path 0.00269. That last figure reflects that path's scaling rather than turbo's advantage — it divides by the L2 norm first, so at d=768 it emits no code larger than 8 of 127 and discards three of its eight bits before any comparison. Turbo's real property is distribution-independence: with 2 dimensions at 20x (the outlier dimensions real embedding models exhibit) turbo measures 0.00039 against max-abs's 0.00174, while on well-conditioned inputs max-abs is the slightly more accurate of the two. Choose linear when the output must keep its input length.",
      default: QuantizationMethod.LINEAR,
    },
    turboSeed: {
      type: "integer",
      title: "TurboQuant Seed",
      description:
        "Seed for the random rotation in TurboQuant. All vectors in the same collection must use the same seed for similarity search to work.",
      default: DEFAULT_SEED,
    },
    turboPadToPowerOf2: {
      type: "boolean",
      title: "TurboQuant Pad To Power Of 2",
      description:
        "Allow method 'turbo' on a non-power-of-2 dimensionality by widening the output to turboPaddedLength(d). Defaults to false because enabling it lengthens the output vector: a storage column sized to d will reject the result, so it has to be an explicit choice rather than a silent one. Ignored unless method is 'turbo'.",
      default: false,
    },
  },
  required: ["vector", "targetType"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    vector: {
      anyOf: [
        TypedArraySchema({
          title: "Quantized Vector",
          description: "The quantized vector",
        }),
        {
          type: "array",
          items: TypedArraySchema({
            title: "Quantized Vector",
            description: "Quantized vector",
          }),
        },
      ],
      title: "Output Vector(s)",
      description: "Quantized vector or array of vectors",
    },
    originalType: {
      type: "string",
      enum: Object.values(TensorType),
      title: "Original Type",
      description: "Original vector type",
    },
    targetType: {
      type: "string",
      enum: Object.values(TensorType),
      title: "Target Type",
      description: "Target quantization type",
    },
    method: {
      type: "string",
      enum: Object.values(QuantizationMethod),
      title: "Method",
      description:
        "Quantization method that produced the output vector. Recorded so downstream consumers can tell a turbo-rotated vector from a linearly quantized one — the two are not comparable.",
    },
    turboSeed: {
      type: "integer",
      title: "TurboQuant Seed",
      description:
        "Seed of the random rotation applied when method is 'turbo' (absent otherwise). Vectors quantized with different seeds, or mixed with vectors quantized using method 'linear', are NOT comparable: cosine similarity between them is meaningless and no error is raised.",
    },
    originalDimensions: {
      type: "integer",
      title: "Original Dimensions",
      description:
        "The input dimensionality before quantization. Differs from the output vector's length only when turboPadToPowerOf2 widened it, and is recorded so a consumer can tell a widened vector from a model that genuinely emits that many dimensions — the two are indistinguishable from the output alone.",
    },
  },
  required: ["vector", "originalType", "targetType", "method", "originalDimensions"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type VectorQuantizeTaskInput = {
  normalize?: boolean | undefined;
  vector: TypedArray | TypedArray[];
  targetType: "float16" | "float32" | "float64" | "int8" | "uint8" | "int16" | "uint16";
  readonly method?: QuantizationMethod | undefined;
  readonly turboSeed?: number | undefined;
  /**
   * Opt into a `turboPaddedLength(d)`-length output for `method: "turbo"` at a non-power-of-2
   * dimensionality. Defaults to false: it lengthens the output vector.
   */
  readonly turboPadToPowerOf2?: boolean | undefined;
};
export type VectorQuantizeTaskOutput = {
  vector: TypedArray | TypedArray[];
  targetType: "float16" | "float32" | "float64" | "int8" | "uint8" | "int16" | "uint16";
  originalType: "float16" | "float32" | "float64" | "int8" | "uint8" | "int16" | "uint16";
  /** Method that produced `vector`. A turbo vector is not comparable with a linear one. */
  readonly method: QuantizationMethod;
  /** Rotation seed, present only for `method: "turbo"`. Different seeds are not comparable. */
  readonly turboSeed: number | undefined;
  /**
   * Input dimensionality before quantization. Differs from `vector`'s length only when
   * `turboPadToPowerOf2` widened it; recorded so a consumer can tell a widened vector from
   * a model that genuinely emits that many dimensions. For the array form this reports the
   * FIRST vector's length.
   */
  readonly originalDimensions: number;
};
export type VectorQuantizeTaskConfig = TaskConfig<VectorQuantizeTaskInput>;

/**
 * Task for quantizing vectors to reduce storage and improve performance.
 * Supports various quantization types including binary, int8, uint8, int16, uint16.
 */
export class VectorQuantizeTask extends Task<
  VectorQuantizeTaskInput,
  VectorQuantizeTaskOutput,
  VectorQuantizeTaskConfig
> {
  public static override type = "VectorQuantizeTask";
  /** Pure-compute vector quantization — no provider capability required. */
  public static readonly requires: readonly Capability[] = [] as const satisfies Capability[];
  public static override category = "Vector";
  public static override title = "Quantize";
  public static override description = "Quantize vectors to reduce storage and improve performance";
  public static override cacheable = true;

  public static override inputSchema(): DataPortSchema {
    return inputSchema as DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return outputSchema as DataPortSchema;
  }

  override async execute(input: VectorQuantizeTaskInput): Promise<VectorQuantizeTaskOutput> {
    // Quantization is a pure transform; preview and full-run share implementation.
    return this.executePreview(input);
  }

  override async executePreview(input: VectorQuantizeTaskInput): Promise<VectorQuantizeTaskOutput> {
    const {
      vector,
      targetType,
      normalize = true,
      method = QuantizationMethod.LINEAR,
      turboSeed = DEFAULT_SEED,
      turboPadToPowerOf2 = false,
    } = input;
    const isArray = Array.isArray(vector);
    const vectors = isArray ? vector : [vector];
    this.assertHomogeneousBatch(vectors, method, turboPadToPowerOf2);
    const originalType = this.getVectorType(vectors[0]);

    let quantized: TypedArray[];

    if (method === QuantizationMethod.TURBO) {
      // TurboQuant is restricted to signed integer targets: an unsigned target
      // encodes a DC offset that breaks cosine similarity (translation is not a
      // cosine invariant), and float targets have no quantization to do.
      if (targetType !== TensorType.INT8 && targetType !== TensorType.INT16) {
        throw new Error(
          `VectorQuantizeTask: method "turbo" supports signed integer target types only (int8, int16), got "${targetType}"`
        );
      }
      // Checked here rather than left to turboQuantizeToTypedArray so the message names
      // the task's own input rather than the util's option object. Turbo rotates in
      // turboPaddedLength(d) dimensions, so at a non-power-of-2 d it either widens the output
      // or discards coordinates; only the first is offered.
      const unpadded = turboPadToPowerOf2
        ? undefined
        : vectors.find((v) => v.length !== turboPaddedLength(v.length));
      if (unpadded !== undefined) {
        const padded = turboPaddedLength(unpadded.length);
        throw new Error(
          `VectorQuantizeTask: method "turbo" needs turboPadToPowerOf2: true at a non-power-of-2 ` +
            `vector dimensionality, got ${unpadded.length}. Setting it widens the output from ` +
            `${unpadded.length} to ${padded} values — the output is LONGER than the input, so ` +
            `size any fixed-width storage column to ${padded}, not ${unpadded.length}. Turbo is ` +
            `not automatically the more accurate option: against a max-abs int8 quantizer ` +
            `(divide by max|v|, then scale to +/-127) padded turbo is slightly WORSE on ` +
            `well-conditioned inputs (int8 cosine RMSE at d=768: 0.00034 vs 0.00024) and several ` +
            `times BETTER when the input carries outlier dimensions (0.00039 vs 0.00174), which ` +
            `is the trade padding actually buys. This task's own method: "linear" measures 0.00269 ` +
            `at d=768, but that reflects its L2-then-x127 scaling (which emits no code larger ` +
            `than 8 of 127 there) rather than any property of turbo. Use method: "linear" if the ` +
            `output must keep its ${unpadded.length} length.`
        );
      }
      quantized = vectors.map((v) =>
        turboQuantizeToTypedArray(v, targetType, {
          seed: turboSeed,
          padToPowerOf2: turboPadToPowerOf2,
        })
      );
    } else {
      quantized = vectors.map((v) => this.vectorQuantize(v, targetType, normalize));
    }

    return {
      vector: isArray ? quantized : quantized[0],
      originalType,
      targetType,
      method,
      turboSeed: method === QuantizationMethod.TURBO ? turboSeed : undefined,
      originalDimensions: vectors[0].length,
    };
  }

  /**
   * Rejects a batch whose vectors do not all share one dimensionality and one element
   * type, under every method.
   *
   * `originalDimensions` and `originalType` describe `vectors[0]` alone, so a mixed batch
   * returns metadata that is a claim about one vector presented as a claim about all of
   * them. What follows differs by method, and the message says which:
   *
   * - `turbo`: each vector is rotated in its own `turboPaddedLength(d)` under
   *   `getSignTable(seed, paddedLen)` — a different basis per length — so the outputs are
   *   not comparable at all, and padding does not reconcile them (700 and 1100 land in
   *   1024 and 2048). The per-vector power-of-2 check passes such a batch: it asks a
   *   per-vector question about a batch-level invariant.
   * - `linear`: the outputs keep their input lengths, so `cosineSimilarity` throws
   *   downstream — but `originalDimensions` has already misreported before that, and a
   *   fixed-width storage column accepts one output and rejects the other.
   *
   * The mixed ELEMENT-TYPE case is the same defect on the other metadata field, and is
   * rejected for the same reason rather than left to misreport `originalType`.
   */
  private assertHomogeneousBatch(
    vectors: TypedArray[],
    method: QuantizationMethod,
    turboPadToPowerOf2: boolean
  ): void {
    if (vectors.length === 0) {
      // Reached `getVectorType(undefined)` before this guard and threw "Unknown vector
      // type: undefined", which names neither the input nor the shape of the mistake.
      throw new Error(
        `VectorQuantizeTask: input "vector" is an empty array — there is nothing to quantize, ` +
          `and the output's originalType and originalDimensions describe vectors[0], which does ` +
          `not exist. Pass at least one vector, or skip the call.`
      );
    }

    const expected = vectors[0]!.length;
    const index = vectors.findIndex((v) => v.length !== expected);
    if (index !== -1) {
      const found = vectors[index]!.length;
      const consequence =
        method === QuantizationMethod.TURBO
          ? `Under method "turbo" each vector is rotated in its own turboPaddedLength(d) — ` +
            `${turboPaddedLength(expected)} and ${turboPaddedLength(found)} here — and the ` +
            `rotation basis is keyed by that padded length, so the two outputs live in DIFFERENT ` +
            `bases and are not comparable even after padding` +
            (turboPadToPowerOf2 ? "" : " (nor would turboPadToPowerOf2: true make them so)") +
            `.`
          : `Under method "${method}" each output keeps its input length, so cosineSimilarity ` +
            `throws on any pair of them downstream — and a fixed-width storage column accepts ` +
            `one and rejects the other.`;
      throw new Error(
        `VectorQuantizeTask: every vector in a batch must have the same dimensionality, but ` +
          `vectors[0] has ${expected} and vectors[${index}] has ${found}. ${consequence} The ` +
          `output's originalDimensions would also report only vectors[0]'s ${expected}. ` +
          `Quantize each dimensionality in a separate call.`
      );
    }

    const expectedType = this.getVectorType(vectors[0]!);
    const typeIndex = vectors.findIndex((v) => this.getVectorType(v) !== expectedType);
    if (typeIndex !== -1) {
      throw new Error(
        `VectorQuantizeTask: every vector in a batch must have the same element type, but ` +
          `vectors[0] is ${expectedType} and vectors[${typeIndex}] is ` +
          `${this.getVectorType(vectors[typeIndex]!)}. The output's originalType would report ` +
          `only vectors[0]'s ${expectedType}, which is the one field a consumer has to reverse ` +
          `the quantization. Quantize each element type in a separate call.`
      );
    }
  }

  private getVectorType(vector: TypedArray): TensorType {
    if (vector instanceof Float16Array) return TensorType.FLOAT16;
    if (vector instanceof Float32Array) return TensorType.FLOAT32;
    if (vector instanceof Float64Array) return TensorType.FLOAT64;
    if (vector instanceof Int8Array) return TensorType.INT8;
    if (vector instanceof Uint8Array) return TensorType.UINT8;
    if (vector instanceof Int16Array) return TensorType.INT16;
    if (vector instanceof Uint16Array) return TensorType.UINT16;
    throw new Error(`Unknown vector type: ${typeof vector}`);
  }

  private vectorQuantize(
    vector: TypedArray,
    targetType: TensorType,
    normalize: boolean
  ): TypedArray {
    let values = Array.from(vector) as number[];

    // Normalize if requested
    if (normalize) {
      values = normalizeNumberArray(values, false);
    }

    switch (targetType) {
      case TensorType.FLOAT16:
        return new Float16Array(values);

      case TensorType.FLOAT32:
        return new Float32Array(values);

      case TensorType.FLOAT64:
        return new Float64Array(values);

      case TensorType.INT8:
        return this.quantizeToInt8(values);

      case TensorType.UINT8:
        return this.quantizeToUint8(values);

      case TensorType.INT16:
        return this.quantizeToInt16(values);

      case TensorType.UINT16:
        return this.quantizeToUint16(values);

      default:
        return new Float32Array(values);
    }
  }

  /**
   * Find min and max values in a single pass for better performance
   */
  private findMinMax(values: number[]): { min: number; max: number } {
    if (values.length === 0) {
      return { min: 0, max: 1 };
    }

    let min = values[0];
    let max = values[0];

    for (let i = 1; i < values.length; i++) {
      const val = values[i];
      if (val < min) min = val;
      if (val > max) max = val;
    }

    return { min, max };
  }

  private quantizeToInt8(values: number[]): Int8Array {
    // Assume values are in [-1, 1] range after normalization
    // Scale to [-127, 127] to avoid overflow at -128
    return new Int8Array(values.map((v) => Math.round(Math.max(-1, Math.min(1, v)) * 127)));
  }

  private quantizeToUint8(values: number[]): Uint8Array {
    // Find min/max for scaling in a single pass
    const { min, max } = this.findMinMax(values);
    const range = max - min || 1;

    // Scale to [0, 255]
    return new Uint8Array(values.map((v) => Math.round(((v - min) / range) * 255)));
  }

  private quantizeToInt16(values: number[]): Int16Array {
    // Assume values are in [-1, 1] range after normalization
    // Scale to [-32767, 32767]
    return new Int16Array(values.map((v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767)));
  }

  private quantizeToUint16(values: number[]): Uint16Array {
    // Find min/max for scaling in a single pass
    const { min, max } = this.findMinMax(values);
    const range = max - min || 1;

    // Scale to [0, 65535]
    return new Uint16Array(values.map((v) => Math.round(((v - min) / range) * 65535)));
  }
}

export const vectorQuantize = (
  input: VectorQuantizeTaskInput,
  config?: VectorQuantizeTaskConfig,
  runConfig?: Partial<IRunConfig>
) => {
  return new VectorQuantizeTask(config).run(input, runConfig);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    vectorQuantize: CreateWorkflow<
      VectorQuantizeTaskInput,
      VectorQuantizeTaskOutput,
      VectorQuantizeTaskConfig
    >;
  }
}

Workflow.prototype.vectorQuantize = CreateWorkflow(VectorQuantizeTask);
