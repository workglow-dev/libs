/**
 * @copyright
 * Copyright 2026 Steven Roussey
 * All Rights Reserved
 */
import { CreateWorkflow, Workflow, type TaskConfig } from "@workglow/task-graph";
import { ImageValueSchema } from "@workglow/util/media";
import type { DataPortSchema } from "@workglow/util/schema";
import { ImageFilterTask, type ImageFilterInput, type ImageFilterOutput } from "../ImageFilterTask";
import type { ResizeParams } from "./resize.cpu";

/** Per-side ceiling a builder can flag before a run; the pixel budget still applies. */
const MAX_IMAGE_SIDE = 16384;

const inputSchema = {
  type: "object",
  properties: {
    image: ImageValueSchema({ title: "Image", description: "Source image" }),
    width: {
      type: "integer",
      title: "Width",
      description: "Target width in pixels",
      minimum: 1,
      maximum: MAX_IMAGE_SIDE,
    },
    height: {
      type: "integer",
      title: "Height",
      description: "Target height in pixels",
      minimum: 1,
      maximum: MAX_IMAGE_SIDE,
    },
    fit: {
      type: "string",
      enum: ["cover", "contain", "fill", "inside", "outside"],
      title: "Fit",
      description: "How the image should be resized to fit",
    },
    kernel: {
      type: "string",
      enum: ["nearest", "cubic", "mitchell", "lanczos2", "lanczos3"],
      title: "Kernel",
      description: "Resampling kernel",
    },
  },
  required: ["image", "width", "height"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: { image: ImageValueSchema({ title: "Image", description: "Resized image" }) },
  required: ["image"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export interface ImageResizeTaskInput extends ImageFilterInput {
  width: number;
  height: number;
  fit?: string;
  kernel?: string;
}
export type ImageResizeTaskOutput = ImageFilterOutput & Record<string, unknown>;

export class ImageResizeTask extends ImageFilterTask<
  ResizeParams,
  ImageResizeTaskInput & Record<string, unknown>,
  ImageResizeTaskOutput
> {
  static override readonly type = "ImageResizeTask";
  static override readonly category = "Image";
  public static override title = "Resize Image";
  public static override description = "Resizes an image using nearest-neighbor sampling";

  static override inputSchema() {
    return inputSchema;
  }
  static override outputSchema() {
    return outputSchema;
  }

  protected readonly filterName = "resize";
  protected opParams(input: ImageResizeTaskInput & Record<string, unknown>): ResizeParams {
    return {
      width: input.width as number,
      height: input.height as number,
      fit: input.fit as string | undefined,
      kernel: input.kernel as string | undefined,
    };
  }

  /**
   * `outside` keeps the aspect ratio and covers both targets, so it can grow past
   * width x height; every other fit stays within it.
   */
  protected override outputSize(
    { width, height, fit }: ResizeParams,
    source: { readonly width: number; readonly height: number }
  ): { readonly width: number; readonly height: number } {
    if (fit !== "outside") return { width, height };
    const scale = Math.max(width / source.width, height / source.height);
    return {
      width: Math.max(width, Math.round(source.width * scale)),
      height: Math.max(height, Math.round(source.height * scale)),
    };
  }

  protected override scalePreviewParams(
    { width, height, fit, kernel }: ResizeParams,
    s: number
  ): ResizeParams {
    return {
      width: Math.max(1, Math.round(width * s)),
      height: Math.max(1, Math.round(height * s)),
      fit,
      kernel,
    };
  }
}

declare module "@workglow/task-graph" {
  interface Workflow {
    imageResize: CreateWorkflow<
      ImageResizeTaskInput & Record<string, unknown>,
      ImageResizeTaskOutput,
      TaskConfig
    >;
  }
}

Workflow.prototype.imageResize = CreateWorkflow(ImageResizeTask);
