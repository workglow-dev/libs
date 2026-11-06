/**
 * @copyright
 * Copyright 2026 Steven Roussey
 * All Rights Reserved
 */
import type { IExecuteContext, IExecutePreviewContext, TaskConfig } from "@workglow/task-graph";
import { Task, TaskInvalidInputError } from "@workglow/task-graph";
import type { GpuImage, ImageValue } from "@workglow/util/media";
import { applyFilter, CpuImage, GpuImageFactory, hasFilterOp } from "@workglow/util/media";
import { assertWithinPixelBudget } from "./imageCodecLimits";

export interface ImageFilterInput {
  image: ImageValue;
}
export interface ImageFilterOutput {
  image: ImageValue;
}

export abstract class ImageFilterTask<
  P,
  Input extends ImageFilterInput & Record<string, unknown> = ImageFilterInput &
    Record<string, unknown>,
  Output extends ImageFilterOutput & Record<string, unknown> = ImageFilterOutput &
    Record<string, unknown>,
  Config extends TaskConfig = TaskConfig,
> extends Task<Input, Output, Config> {
  protected abstract readonly filterName: string;
  protected abstract opParams(input: Input): P;

  /**
   * Override in subclasses to scale pixel-space params. Default is identity.
   * Always called before applyFilter; multiply-by-1 in run mode is a no-op.
   */
  protected scalePreviewParams(params: P, _scale: number): P {
    return params;
  }

  /**
   * The largest output this filter can build from a source of the given size, for a
   * filter that changes the size. It is held to the pixel budget decoding is, before
   * any buffer is allocated. Undefined (the default) for a filter that keeps the size.
   */
  protected outputSize(
    _params: P,
    _source: { readonly width: number; readonly height: number }
  ): { readonly width: number; readonly height: number } | undefined {
    return undefined;
  }

  private assertOutputWithinBudget(params: P, source: GpuImage): void {
    const size = this.outputSize(params, source);
    if (!size) return;
    try {
      assertWithinPixelBudget(size.width, size.height);
    } catch (err) {
      throw new TaskInvalidInputError(
        `${this.type}: output ${size.width}x${size.height} is over the image pixel budget`,
        { cause: err }
      );
    }
  }

  private async runFilter(input: Input): Promise<Output | undefined> {
    const previewScale = input.image.previewScale;
    let gpu: GpuImage = await GpuImageFactory.from(input.image);
    try {
      if (!hasFilterOp(gpu.backend, this.filterName)) {
        const cpu = await CpuImage.from(input.image);
        gpu.dispose();
        gpu = cpu;
      }
      const params = this.scalePreviewParams(this.opParams(input), previewScale);
      this.assertOutputWithinBudget(params, gpu);
      const out = applyFilter(gpu, this.filterName, params);
      gpu.dispose();
      try {
        const value = await out.toImageValue(previewScale);
        return { image: value } as Output;
      } catch (err) {
        // toImageValue self-disposes on success; this catches a throw before
        // that disposal runs (e.g. a sync precondition failure).
        try {
          out.dispose();
        } catch {
          // already disposed
        }
        throw err;
      }
    } catch (err) {
      gpu.dispose();
      throw err;
    }
  }

  override async execute(input: Input, _ctx: IExecuteContext): Promise<Output | undefined> {
    return this.runFilter(input);
  }

  override async executePreview(
    input: Input,
    _ctx: IExecutePreviewContext
  ): Promise<Output | undefined> {
    return this.runFilter(input);
  }
}
