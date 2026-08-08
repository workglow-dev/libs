/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IRunConfig, TaskConfig } from "@workglow/task-graph";
import { CreateWorkflow, Task, Workflow } from "@workglow/task-graph";
import type { DataPortSchema, TypedArray } from "@workglow/util/schema";
import {
  normalizeNumberArray,
  TensorType,
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
        "Quantization method: 'linear' for simple min-max scaling, 'turbo' for TurboQuant (randomized Hadamard rotation + uniform scalar quantization at the MSE-optimal Gaussian clipping range). Turbo requires a signed integer targetType (int8 or int16) AND a power-of-2 vector dimensionality: it rotates in nextPowerOf2(d) dimensions, so a non-power-of-2 input is rejected rather than silently degraded. At equal byte width linear is measurably more accurate at the common embedding sizes — measured int8 cosine RMSE, turbo vs linear: 0.0164 vs 0.0027 at d=768, 0.0126 vs 0.0033 at d=1536, 0.0094 vs 0.0026 at d=3072. Turbo wins only at d=1024 (0.0008 vs 0.0033).",
      default: QuantizationMethod.LINEAR,
    },
    turboSeed: {
      type: "integer",
      title: "TurboQuant Seed",
      description:
        "Seed for the random rotation in TurboQuant. All vectors in the same collection must use the same seed for similarity search to work.",
      default: 42,
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
  },
  required: ["vector", "originalType", "targetType", "method"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type VectorQuantizeTaskInput = {
  normalize?: boolean | undefined;
  vector: TypedArray | TypedArray[];
  targetType: "float16" | "float32" | "float64" | "int8" | "uint8" | "int16" | "uint16";
  readonly method?: QuantizationMethod | undefined;
  readonly turboSeed?: number | undefined;
};
export type VectorQuantizeTaskOutput = {
  vector: TypedArray | TypedArray[];
  targetType: "float16" | "float32" | "float64" | "int8" | "uint8" | "int16" | "uint16";
  originalType: "float16" | "float32" | "float64" | "int8" | "uint8" | "int16" | "uint16";
  /** Method that produced `vector`. A turbo vector is not comparable with a linear one. */
  readonly method: QuantizationMethod;
  /** Rotation seed, present only for `method: "turbo"`. Different seeds are not comparable. */
  readonly turboSeed: number | undefined;
};
export type VectorQuantizeTaskConfig = TaskConfig<VectorQuantizeTaskInput>;

/** Smallest power of 2 that is >= n. Doubles rather than shifts to stay 32-bit safe. */
function nextPowerOf2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

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
      turboSeed = 42,
    } = input;
    const isArray = Array.isArray(vector);
    const vectors = isArray ? vector : [vector];
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
      // the task's own remedies. Turbo rotates in nextPowerOf2(d) dimensions and cannot
      // return a d-length result without discarding coordinates, which measures worse
      // than linear at exactly the dimensionalities embedding models use.
      const unpadded = vectors.find((v) => v.length !== nextPowerOf2(v.length));
      if (unpadded !== undefined) {
        throw new Error(
          `VectorQuantizeTask: method "turbo" requires a power of 2 vector dimensionality, got ${unpadded.length}. ` +
            `Either use method: "linear" at this dimensionality (it is measurably more accurate here — ` +
            `int8 cosine RMSE at d=768: linear 0.0027 vs turbo 0.0164), or zero-pad the vectors to ` +
            `${nextPowerOf2(unpadded.length)} before quantizing and size the storage column to match.`
        );
      }
      quantized = vectors.map((v) => turboQuantizeToTypedArray(v, targetType, turboSeed));
    } else {
      quantized = vectors.map((v) => this.vectorQuantize(v, targetType, normalize));
    }

    return {
      vector: isArray ? quantized : quantized[0],
      originalType,
      targetType,
      method,
      turboSeed: method === QuantizationMethod.TURBO ? turboSeed : undefined,
    };
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
