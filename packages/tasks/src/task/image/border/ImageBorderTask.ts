/**
 * @copyright
 * Copyright 2026 Steven Roussey
 * All Rights Reserved
 */
import { CreateWorkflow, Workflow, type TaskConfig } from "@workglow/task-graph";
import { ImageValueSchema } from "@workglow/util/media";
import type { DataPortSchema } from "@workglow/util/schema";
import { ImageFilterTask, type ImageFilterInput, type ImageFilterOutput } from "../ImageFilterTask";
import type { BorderParams } from "./border.cpu";

const inputSchema = {
  type: "object",
  properties: {
    image: ImageValueSchema({ title: "Image", description: "Source image" }),
    borderWidth: {
      type: "integer",
      title: "Border Width",
      description: "Border width in pixels",
      minimum: 1,
      maximum: 8192,
      default: 10,
    },
    color: {
      oneOf: [
        { type: "string", pattern: "^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$" },
        {
          type: "object",
          properties: {
            r: { type: "integer", minimum: 0, maximum: 255 },
            g: { type: "integer", minimum: 0, maximum: 255 },
            b: { type: "integer", minimum: 0, maximum: 255 },
            a: { type: "integer", minimum: 0, maximum: 255 },
          },
          required: ["r", "g", "b"],
          additionalProperties: false,
        },
      ],
      title: "Color",
      description: "Border color",
      default: "#000000",
    },
  },
  required: ["image", "color"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: { image: ImageValueSchema({ title: "Image", description: "Image with border" }) },
  required: ["image"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export interface ImageBorderTaskInput extends ImageFilterInput {
  borderWidth?: number;
  color: string | { r: number; g: number; b: number; a?: number };
}
export type ImageBorderTaskOutput = ImageFilterOutput & Record<string, unknown>;

export class ImageBorderTask extends ImageFilterTask<
  BorderParams,
  ImageBorderTaskInput & Record<string, unknown>,
  ImageBorderTaskOutput
> {
  static override readonly type = "ImageBorderTask";
  static override readonly category = "Image";
  public static override title = "Add Border";
  public static override description = "Adds a colored border around an image";

  static override inputSchema() {
    return inputSchema;
  }
  static override outputSchema() {
    return outputSchema;
  }

  protected readonly filterName = "border";
  protected opParams(input: ImageBorderTaskInput & Record<string, unknown>): BorderParams {
    return {
      borderWidth: (input.borderWidth as number | undefined) ?? 10,
      color: input.color as string | { r: number; g: number; b: number; a?: number },
    };
  }

  protected override outputSize(
    { borderWidth }: BorderParams,
    source: { readonly width: number; readonly height: number }
  ): { readonly width: number; readonly height: number } {
    return { width: source.width + 2 * borderWidth, height: source.height + 2 * borderWidth };
  }

  protected override scalePreviewParams(
    { borderWidth, color }: BorderParams,
    s: number
  ): BorderParams {
    return { borderWidth: Math.max(1, Math.round(borderWidth * s)), color };
  }
}

declare module "@workglow/task-graph" {
  interface Workflow {
    imageBorder: CreateWorkflow<
      ImageBorderTaskInput & Record<string, unknown>,
      ImageBorderTaskOutput,
      TaskConfig
    >;
  }
}

Workflow.prototype.imageBorder = CreateWorkflow(ImageBorderTask);
