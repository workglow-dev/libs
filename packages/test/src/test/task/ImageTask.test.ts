/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ImageBlurTask,
  ImageBorderTask,
  ImageBrightnessTask,
  ImageContrastTask,
  ImageCropTask,
  ImageFlipTask,
  ImageGrayscaleTask,
  ImageInvertTask,
  ImagePixelateTask,
  ImagePosterizeTask,
  ImageResizeTask,
  ImageRotateTask,
  ImageSepiaTask,
  ImageTextTask,
  ImageThresholdTask,
  ImageTintTask,
  ImageTransparencyTask,
} from "@workglow/tasks";
import { TaskInvalidInputError } from "@workglow/task-graph";
import { setLogger } from "@workglow/util";
import {
  CpuImage,
  imageValueFromBuffer,
  type ImageValue,
  type RawPixelBuffer,
} from "@workglow/util/media";
import { getTestingLogger } from "@workglow/util/test";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Helpers — build ImageValue inputs and read back CpuImage pixel buffers.
//
// The ImageValue boundary always carries 4-channel raw-rgba in node (the
// CpuImage → ImageValue egress in `cpuImage.ts` expands 1/3-channel buffers
// to RGBA). So tests that originally constructed 1/3-channel fixtures now
// see 4-channel inputs at the task boundary; assertions that previously
// inspected `out.channels` are updated to reflect the 4-channel egress
// (with luma replicated across R/G/B for grayscale fixtures).
// ---------------------------------------------------------------------------

function createTestImage(
  w: number,
  h: number,
  channels: 1 | 3 | 4,
  fill?: number[]
): RawPixelBuffer {
  const data = new Uint8ClampedArray(w * h * channels);
  if (fill) {
    for (let i = 0; i < w * h; i++) {
      for (let c = 0; c < channels; c++) {
        data[i * channels + c] = fill[c % fill.length]!;
      }
    }
  }
  return { data, width: w, height: h, channels };
}

/**
 * Build an `ImageValue` from a `RawPixelBuffer`. For 4-channel buffers the
 * data is wrapped directly as `raw-rgba`; for 1- or 3-channel buffers we
 * expand to 4-channel RGBA first (replicating luma for 1-channel, opaque
 * alpha for 3-channel) so the value matches the format hint.
 */
function toImageValue(bin: RawPixelBuffer, previewScale = 1.0): ImageValue {
  const { data, width, height, channels } = bin;
  let rgba: Uint8ClampedArray;
  if (channels === 4) {
    rgba = data;
  } else if (channels === 3) {
    rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4 + 0] = data[i * 3 + 0]!;
      rgba[i * 4 + 1] = data[i * 3 + 1]!;
      rgba[i * 4 + 2] = data[i * 3 + 2]!;
      rgba[i * 4 + 3] = 255;
    }
  } else {
    rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const g = data[i] ?? 0;
      rgba[i * 4 + 0] = g;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = g;
      rgba[i * 4 + 3] = 255;
    }
  }
  const buf = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return imageValueFromBuffer(buf, "raw-rgba", width, height, previewScale);
}

async function readPixels(value: ImageValue): Promise<RawPixelBuffer> {
  const cpu = await CpuImage.from(value);
  return cpu.getBinary();
}

function getPixel(image: RawPixelBuffer, x: number, y: number): number[] {
  const idx = (y * image.width + x) * image.channels;
  const pixel: number[] = [];
  for (let c = 0; c < image.channels; c++) {
    pixel.push(image.data[idx + c] ?? 0);
  }
  return pixel;
}

function getAlpha(image: RawPixelBuffer, x: number, y: number): number {
  if (image.channels < 4) return 255;
  const idx = (y * image.width + x) * image.channels;
  return image.data[idx + 3] ?? 0;
}

function countTextishPixels(image: RawPixelBuffer, alphaThreshold = 8): number {
  let n = 0;
  const ch = image.channels;
  if (ch < 4) return 0;
  for (let i = ch - 1; i < image.data.length; i += ch) {
    if ((image.data[i] ?? 0) > alphaThreshold) n++;
  }
  return n;
}

function getMaxAlpha(image: RawPixelBuffer): number {
  if (image.channels < 4) return 255;
  let max = 0;
  for (let i = 3; i < image.data.length; i += image.channels) {
    max = Math.max(max, image.data[i] ?? 0);
  }
  return max;
}

function getAlphaBounds(
  image: RawPixelBuffer,
  alphaThreshold = 8
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const { width, height, data, channels } = image;
  if (channels !== 4) return null;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3] ?? 0;
      if (a > alphaThreshold) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

function getPixelWithHighestAlphaInBounds(
  image: RawPixelBuffer,
  b: { minX: number; minY: number; maxX: number; maxY: number }
): number[] {
  let bestA = -1;
  let bestX = b.minX;
  let bestY = b.minY;
  for (let y = b.minY; y <= b.maxY; y++) {
    for (let x = b.minX; x <= b.maxX; x++) {
      const a = getAlpha(image, x, y);
      if (a > bestA) {
        bestA = a;
        bestX = x;
        bestY = y;
      }
    }
  }
  return getPixel(image, bestX, bestY);
}

describe("ImageTask", () => {
  const logger = getTestingLogger();
  setLogger(logger);

  describe("Image input / output transport", () => {
    test("returns an ImageValue when input image is an ImageValue", async () => {
      const image = toImageValue(createTestImage(1, 1, 3, [255, 255, 255]));
      const task = new ImageInvertTask();
      const result = (await task.run({ image })) as { image: ImageValue };
      expect(typeof result.image).toBe("object");
      const out = await readPixels(result.image);
      expect(out.width).toBe(1);
      expect(out.height).toBe(1);
    });

    test("inverts a 1x1 RGB image through the task boundary", async () => {
      const image = toImageValue(createTestImage(1, 1, 3, [0, 0, 0]));
      const task = new ImageInvertTask();
      const result = (await task.run({ image })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(out.width).toBe(1);
      expect(out.height).toBe(1);
      // Boundary always re-emits 4-channel RGBA.
      expect(getPixel(out, 0, 0).slice(0, 3)).toEqual([255, 255, 255]);
    });
  });

  describe("ImageResizeTask", () => {
    test("upscales a 2x2 image to 4x4", async () => {
      const image = toImageValue(createTestImage(2, 2, 3, [100, 150, 200]));
      const task = new ImageResizeTask();
      const result = (await task.run({ image, width: 4, height: 4 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(out.width).toBe(4);
      expect(out.height).toBe(4);
      expect(out.data.length).toBe(4 * 4 * out.channels);
    });

    test("downscales a 4x4 image to 2x2", async () => {
      const image = toImageValue(createTestImage(4, 4, 3, [80, 120, 160]));
      const task = new ImageResizeTask();
      const result = (await task.run({ image, width: 2, height: 2 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(out.width).toBe(2);
      expect(out.height).toBe(2);
    });
  });

  describe("ImageCropTask", () => {
    test("crops a rectangular region", async () => {
      const image = toImageValue(createTestImage(4, 4, 3, [100, 150, 200]));
      const task = new ImageCropTask();
      const result = (await task.run({ image, left: 1, top: 1, width: 2, height: 2 })) as {
        image: ImageValue;
      };
      const out = await readPixels(result.image);
      expect(out.width).toBe(2);
      expect(out.height).toBe(2);
    });

    test("crops to image bounds at the edge", async () => {
      // Note: the per-filter test (crop.test.ts) covers the CPU arm's clamp
      // behavior directly; sharp's `extract` rejects out-of-bounds requests,
      // so the boundary-level test exercises a valid edge crop.
      const image = toImageValue(createTestImage(4, 4, 3, [100, 150, 200]));
      const task = new ImageCropTask();
      const result = (await task.run({ image, left: 3, top: 3, width: 1, height: 1 })) as {
        image: ImageValue;
      };
      const out = await readPixels(result.image);
      expect(out.width).toBe(1);
      expect(out.height).toBe(1);
    });
  });

  describe("ImageRotateTask", () => {
    test("rotates 90 degrees", async () => {
      const binSrc = createTestImage(2, 3, 1);
      for (let i = 0; i < 6; i++) binSrc.data[i] = i * 40;
      const image = toImageValue(binSrc);
      const task = new ImageRotateTask();
      const result = (await task.run({ image, angle: 90 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(out.width).toBe(3);
      expect(out.height).toBe(2);
    });

    test("rotates 180 degrees preserves dimensions", async () => {
      const binSrc = createTestImage(3, 4, 1);
      for (let i = 0; i < 12; i++) binSrc.data[i] = i * 20;
      const image = toImageValue(binSrc);
      const task = new ImageRotateTask();
      const result = (await task.run({ image, angle: 180 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(out.width).toBe(3);
      expect(out.height).toBe(4);
      // Last row/column of the original ends up at the first; 1-channel input
      // is expanded to RGBA, so compare on the red channel.
      const last = getPixel(out, 2, 3);
      const first = getPixel(out, 0, 0);
      expect(last[0]).toBe(0);
      expect(first[0]).toBe(binSrc.data[11]);
    });

    test("rotates 270 degrees", async () => {
      const binSrc = createTestImage(2, 3, 1);
      const image = toImageValue(binSrc);
      const task = new ImageRotateTask();
      const result = (await task.run({ image, angle: 270 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(out.width).toBe(3);
      expect(out.height).toBe(2);
    });
  });

  describe("ImageFlipTask", () => {
    test("flips horizontally", async () => {
      const bin = createTestImage(3, 1, 1);
      bin.data[0] = 10;
      bin.data[1] = 20;
      bin.data[2] = 30;
      const image = toImageValue(bin);
      const task = new ImageFlipTask();
      const result = (await task.run({ image, direction: "horizontal" })) as { image: ImageValue };
      const out = await readPixels(result.image);
      // 1-channel input expands to 4-channel; check the red component (R=G=B=luma).
      expect(getPixel(out, 0, 0)[0]).toBe(30);
      expect(getPixel(out, 1, 0)[0]).toBe(20);
      expect(getPixel(out, 2, 0)[0]).toBe(10);
    });

    test("flips vertically", async () => {
      const bin = createTestImage(1, 3, 1);
      bin.data[0] = 10;
      bin.data[1] = 20;
      bin.data[2] = 30;
      const image = toImageValue(bin);
      const task = new ImageFlipTask();
      const result = (await task.run({ image, direction: "vertical" })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(getPixel(out, 0, 0)[0]).toBe(30);
      expect(getPixel(out, 0, 1)[0]).toBe(20);
      expect(getPixel(out, 0, 2)[0]).toBe(10);
    });
  });

  describe("ImageGrayscaleTask", () => {
    test("converts RGB to grayscale with replicated luma", async () => {
      const image = toImageValue(createTestImage(2, 2, 3, [255, 0, 0])); // pure red
      const task = new ImageGrayscaleTask();
      const result = (await task.run({ image })) as { image: ImageValue };
      const out = await readPixels(result.image);
      // R/G/B should match (replicated luma); alpha should be opaque.
      const px = getPixel(out, 0, 0);
      expect(px[0]).toBe(px[1]);
      expect(px[1]).toBe(px[2]);
      // Pure red maps to a luma value (sharp's `.grayscale()` uses BT.709
      // weighted by the linear-light pipeline ~127; CPU arm ITU-R 601 ~76).
      // Either way the value must fall well below 200 (red component) but
      // above zero, and not be the original red.
      expect(px[0]!).toBeGreaterThan(0);
      expect(px[0]!).toBeLessThan(200);
    });

    test("expands 1-channel image to grayscale with full alpha", async () => {
      const image = toImageValue(createTestImage(2, 2, 1, [128]));
      const task = new ImageGrayscaleTask();
      const result = (await task.run({ image })) as { image: ImageValue };
      const out = await readPixels(result.image);
      const px = getPixel(out, 0, 0);
      expect(px[0]).toBe(px[1]);
      expect(px[1]).toBe(px[2]);
      // 1-channel grayscale 128 round-trips through RGBA(128,128,128,255),
      // so grayscale of an already-gray pixel must remain ~128.
      expect(Math.abs(px[0]! - 128)).toBeLessThanOrEqual(2);
    });

    test("preserves alpha channel from RGBA input", async () => {
      const image = toImageValue(createTestImage(1, 1, 4, [200, 100, 50, 42]));
      const task = new ImageGrayscaleTask();
      const result = (await task.run({ image })) as { image: ImageValue };
      const out = await readPixels(result.image);
      // Alpha 42 should round-trip exactly.
      const a = getAlpha(out, 0, 0);
      expect(a).toBe(42);
    });
  });

  describe("ImageBorderTask", () => {
    test("adds a border of correct size", async () => {
      const image = toImageValue(createTestImage(4, 4, 3, [100, 100, 100]));
      const task = new ImageBorderTask();
      const result = (await task.run({
        image,
        borderWidth: 2,
        color: { r: 255, g: 0, b: 0 },
      })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(out.width).toBe(8);
      expect(out.height).toBe(8);
      const corner = getPixel(out, 0, 0);
      expect(corner[0]).toBe(255);
      expect(corner[1]).toBe(0);
      expect(corner[2]).toBe(0);
    });
  });

  describe("ImageTransparencyTask", () => {
    test("sets opacity to 0.5 on opaque image", async () => {
      const image = toImageValue(createTestImage(2, 2, 3, [100, 150, 200]));
      const task = new ImageTransparencyTask();
      const result = (await task.run({ image, amount: 0.5 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      // Alpha should be approximately 128 (255 * 0.5).
      const a = getAlpha(out, 0, 0);
      expect(a).toBeGreaterThan(125);
      expect(a).toBeLessThan(130);
    });

    test("sets opacity to 0 makes fully transparent", async () => {
      const image = toImageValue(createTestImage(2, 2, 3, [100, 150, 200]));
      const task = new ImageTransparencyTask();
      const result = (await task.run({ image, amount: 0 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(getAlpha(out, 0, 0)).toBe(0);
    });
  });

  describe("ImageBlurTask", () => {
    test("preserves dimensions", async () => {
      const image = toImageValue(createTestImage(8, 8, 3, [100, 150, 200]));
      const task = new ImageBlurTask();
      const result = (await task.run({ image, radius: 1 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(out.width).toBe(8);
      expect(out.height).toBe(8);
    });

    test("solid color image stays the same", async () => {
      const image = toImageValue(createTestImage(4, 4, 1, [128]));
      const task = new ImageBlurTask();
      const result = (await task.run({ image, radius: 2 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      // Solid 128 grayscale (replicated to RGB) must remain ~128 after blur.
      for (let y = 0; y < out.height; y++) {
        for (let x = 0; x < out.width; x++) {
          const px = getPixel(out, x, y);
          expect(Math.abs(px[0]! - 128)).toBeLessThanOrEqual(2);
          expect(Math.abs(px[1]! - 128)).toBeLessThanOrEqual(2);
          expect(Math.abs(px[2]! - 128)).toBeLessThanOrEqual(2);
        }
      }
    });
  });

  describe("ImagePixelateTask", () => {
    test("preserves dimensions", async () => {
      const image = toImageValue(createTestImage(8, 8, 3, [100, 150, 200]));
      const task = new ImagePixelateTask();
      const result = (await task.run({ image, blockSize: 4 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(out.width).toBe(8);
      expect(out.height).toBe(8);
    });

    test("preserves dimensions for non-square inputs", async () => {
      // The per-filter `pixelate.test.ts` covers the CPU arm's per-block
      // averaging contract directly. At the boundary level, sharp's nearest
      // resize and the CPU arm anchor blocks differently, so we only assert
      // the invariant both share: output dims match input dims.
      const bin = createTestImage(6, 4, 1);
      for (let i = 0; i < 24; i++) bin.data[i] = i * 8;
      const image = toImageValue(bin);
      const task = new ImagePixelateTask();
      const result = (await task.run({ image, blockSize: 2 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(out.width).toBe(6);
      expect(out.height).toBe(4);
    });
  });

  describe("ImageInvertTask", () => {
    test("inverts black to white", async () => {
      const image = toImageValue(createTestImage(1, 1, 3, [0, 0, 0]));
      const task = new ImageInvertTask();
      const result = (await task.run({ image })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(getPixel(out, 0, 0).slice(0, 3)).toEqual([255, 255, 255]);
    });

    test("inverts RGB values", async () => {
      const image = toImageValue(createTestImage(1, 1, 3, [255, 128, 0]));
      const task = new ImageInvertTask();
      const result = (await task.run({ image })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(getPixel(out, 0, 0).slice(0, 3)).toEqual([0, 127, 255]);
    });

    test("preserves alpha channel", async () => {
      const image = toImageValue(createTestImage(1, 1, 4, [100, 150, 200, 50]));
      const task = new ImageInvertTask();
      const result = (await task.run({ image })) as { image: ImageValue };
      const out = await readPixels(result.image);
      const px = getPixel(out, 0, 0);
      expect(px[0]).toBe(155);
      expect(px[1]).toBe(105);
      expect(px[2]).toBe(55);
      expect(getAlpha(out, 0, 0)).toBe(50);
    });
  });

  describe("ImageBrightnessTask", () => {
    test("increases brightness", async () => {
      const image = toImageValue(createTestImage(1, 1, 3, [100, 100, 100]));
      const task = new ImageBrightnessTask();
      const result = (await task.run({ image, amount: 50 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(getPixel(out, 0, 0).slice(0, 3)).toEqual([150, 150, 150]);
    });

    test("clamps at 255", async () => {
      const image = toImageValue(createTestImage(1, 1, 3, [200, 200, 200]));
      const task = new ImageBrightnessTask();
      const result = (await task.run({ image, amount: 100 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(getPixel(out, 0, 0).slice(0, 3)).toEqual([255, 255, 255]);
    });

    test("decreases brightness", async () => {
      const image = toImageValue(createTestImage(1, 1, 3, [100, 100, 100]));
      const task = new ImageBrightnessTask();
      const result = (await task.run({ image, amount: -50 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(getPixel(out, 0, 0).slice(0, 3)).toEqual([50, 50, 50]);
    });
  });

  describe("ImageContrastTask", () => {
    test("zero amount is identity", async () => {
      const image = toImageValue(createTestImage(1, 1, 3, [100, 150, 200]));
      const task = new ImageContrastTask();
      const result = (await task.run({ image, amount: 0 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(getPixel(out, 0, 0).slice(0, 3)).toEqual([100, 150, 200]);
    });

    test("positive contrast increases difference from 128", async () => {
      const image = toImageValue(createTestImage(1, 1, 3, [64, 128, 192]));
      const task = new ImageContrastTask();
      const result = (await task.run({ image, amount: 50 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      const px = getPixel(out, 0, 0);
      expect(px[0]!).toBeLessThan(64);
      // Mid-gray (128) is the contrast pivot — should be exactly preserved.
      expect(Math.abs(px[1]! - 128)).toBeLessThanOrEqual(1);
      expect(px[2]!).toBeGreaterThan(192);
    });
  });

  describe("ImageSepiaTask", () => {
    test("transforms white pixel to sepia", async () => {
      const image = toImageValue(createTestImage(1, 1, 3, [255, 255, 255]));
      const task = new ImageSepiaTask();
      const result = (await task.run({ image })) as { image: ImageValue };
      const out = await readPixels(result.image);
      const pixel = getPixel(out, 0, 0);
      // Sepia of white: R clamps, G is high, B is lowest.
      expect(pixel[0]!).toBeGreaterThanOrEqual(pixel[1]!);
      expect(pixel[1]!).toBeGreaterThan(pixel[2]!);
    });

    test("preserves alpha", async () => {
      const image = toImageValue(createTestImage(1, 1, 4, [100, 100, 100, 50]));
      const task = new ImageSepiaTask();
      const result = (await task.run({ image })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(getAlpha(out, 0, 0)).toBe(50);
    });
  });

  describe("ImageThresholdTask", () => {
    test("values above threshold become white", async () => {
      const image = toImageValue(createTestImage(1, 1, 1, [200]));
      const task = new ImageThresholdTask();
      const result = (await task.run({ image, value: 128 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      // 1-channel 200 → RGBA(200,200,200,255) → threshold → RGBA(255,255,255,*).
      expect(getPixel(out, 0, 0)[0]).toBe(255);
    });

    test("values below threshold become black", async () => {
      const image = toImageValue(createTestImage(1, 1, 1, [50]));
      const task = new ImageThresholdTask();
      const result = (await task.run({ image, value: 128 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(getPixel(out, 0, 0)[0]).toBe(0);
    });

    test("threshold maps a bright RGB pixel to white", async () => {
      // Note: sharp's `.threshold()` converts to grayscale before thresholding,
      // while the CPU arm thresholds per channel. The per-filter test
      // (threshold.test.ts) covers the CPU per-channel semantics directly;
      // here we verify only the boundary contract that bright input ⇒ white.
      const image = toImageValue(createTestImage(1, 1, 3, [255, 200, 255]));
      const task = new ImageThresholdTask();
      const result = (await task.run({ image, value: 128 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      const px = getPixel(out, 0, 0);
      expect(px[0]).toBe(255);
      expect(px[1]).toBe(255);
      expect(px[2]).toBe(255);
    });
  });

  describe("ImagePosterizeTask", () => {
    test("2 levels produces binary values (low pixel)", async () => {
      const image = toImageValue(createTestImage(1, 1, 1, [100]));
      const task = new ImagePosterizeTask();
      const result = (await task.run({ image, levels: 2 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(getPixel(out, 0, 0)[0]).toBe(0);
    });

    test("2 levels on bright pixel", async () => {
      const image = toImageValue(createTestImage(1, 1, 1, [200]));
      const task = new ImagePosterizeTask();
      const result = (await task.run({ image, levels: 2 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(getPixel(out, 0, 0)[0]).toBe(255);
    });

    test("preserves alpha", async () => {
      const image = toImageValue(createTestImage(1, 1, 4, [100, 150, 200, 42]));
      const task = new ImagePosterizeTask();
      const result = (await task.run({ image, levels: 4 })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(getAlpha(out, 0, 0)).toBe(42);
    });
  });

  describe("ImageTintTask", () => {
    test("amount 0 is identity", async () => {
      const image = toImageValue(createTestImage(1, 1, 3, [100, 150, 200]));
      const task = new ImageTintTask();
      const result = (await task.run({
        image,
        color: { r: 255, g: 0, b: 0, a: 255 },
        amount: 0,
      })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(getPixel(out, 0, 0).slice(0, 3)).toEqual([100, 150, 200]);
    });

    test("amount 1 produces tint color", async () => {
      const image = toImageValue(createTestImage(1, 1, 3, [100, 150, 200]));
      const task = new ImageTintTask();
      const result = (await task.run({
        image,
        color: { r: 255, g: 0, b: 0, a: 255 },
        amount: 1,
      })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(getPixel(out, 0, 0).slice(0, 3)).toEqual([255, 0, 0]);
    });

    test("preserves alpha", async () => {
      const image = toImageValue(createTestImage(1, 1, 4, [100, 150, 200, 42]));
      const task = new ImageTintTask();
      const result = (await task.run({
        image,
        color: { r: 255, g: 0, b: 0, a: 255 },
        amount: 0.5,
      })) as { image: ImageValue };
      const out = await readPixels(result.image);
      expect(getAlpha(out, 0, 0)).toBe(42);
    });
  });

  describe("ImageTextTask", () => {
    const base = {
      text: "A",
      font: "sans-serif",
      fontSize: 36,
      bold: false,
      italic: false,
      color: { r: 20, g: 20, b: 20, a: 255 },
      width: 160,
      height: 160,
    } as const;
    const { width: _baseWidth, height: _baseHeight, ...baseWithBackground } = base;

    test("accepts the image branch without width and height", async () => {
      const task = new ImageTextTask();
      const bg = toImageValue(createTestImage(96, 64, 3, [40, 80, 120]));

      const result = (await task.run({
        ...baseWithBackground,
        image: bg,
        position: "bottom-right",
      })) as { image: ImageValue };
      const out = await readPixels(result.image);

      expect(out.width).toBe(96);
      expect(out.height).toBe(64);
    });

    test("accepts the explicit-dimensions branch without image", async () => {
      const task = new ImageTextTask();

      const result = (await task.run({
        ...base,
        width: 96,
        height: 64,
        position: "middle-center",
      })) as { image: ImageValue };
      const out = await readPixels(result.image);

      expect(out.width).toBe(96);
      expect(out.height).toBe(64);
    });

    test("rejects missing both background image and explicit dimensions", async () => {
      const task = new ImageTextTask();

      await expect(
        task.run({
          ...baseWithBackground,
          position: "middle-center",
        })
      ).rejects.toThrow(/does not match schema/);
    });

    test("rejects zero font size", async () => {
      const task = new ImageTextTask();
      await expect(task.run({ ...base, fontSize: 0, position: "middle-center" })).rejects.toThrow(
        /does not match schema/
      );
    });

    test("rejects empty text", async () => {
      const task = new ImageTextTask();
      await expect(task.run({ ...base, text: "", position: "middle-center" })).rejects.toThrow(
        /does not match schema/
      );
    });

    test("outputs RGBA image with requested dimensions", async () => {
      const task = new ImageTextTask();
      const result = (await task.run({ ...base, position: "middle-center" })) as {
        image: ImageValue;
      };
      const out = await readPixels(result.image);
      expect(out.width).toBe(160);
      expect(out.height).toBe(160);
      expect(out.channels).toBe(4);
    });

    test("renders text into a transparent image when width and height are provided", async () => {
      const task = new ImageTextTask();
      const result = (await task.run({
        ...base,
        width: 96,
        height: 64,
        position: "middle-center",
      })) as { image: ImageValue };
      const out = await readPixels(result.image);

      expect(out.width).toBe(96);
      expect(out.height).toBe(64);
      expect(out.channels).toBe(4);
      expect(getAlpha(out, 0, 0)).toBeLessThan(12);
    });

    test("keeps a corner transparent when text is anchored bottom-right", async () => {
      const task = new ImageTextTask();
      const result = (await task.run({ ...base, position: "bottom-right" })) as {
        image: ImageValue;
      };
      const out = await readPixels(result.image);
      expect(getAlpha(out, 0, 0)).toBeLessThan(12);
    });

    test("top-left anchor places ink nearer the upper-left than bottom-right anchor", async () => {
      const task = new ImageTextTask();
      const tlResult = (await task.run({ ...base, position: "top-left" })) as {
        image: ImageValue;
      };
      const brResult = (await task.run({ ...base, position: "bottom-right" })) as {
        image: ImageValue;
      };
      const tl = await readPixels(tlResult.image);
      const br = await readPixels(brResult.image);
      const b1 = getAlphaBounds(tl);
      const b2 = getAlphaBounds(br);
      expect(b1).not.toBeNull();
      expect(b2).not.toBeNull();
      const c1x = (b1!.minX + b1!.maxX) / 2;
      const c1y = (b1!.minY + b1!.maxY) / 2;
      const c2x = (b2!.minX + b2!.maxX) / 2;
      const c2y = (b2!.minY + b2!.maxY) / 2;
      expect(c1x + c1y).toBeLessThan(c2x + c2y);
    });

    test("uses text color in rendered pixels", async () => {
      const task = new ImageTextTask();
      const result = (await task.run({
        ...base,
        color: { r: 200, g: 10, b: 30, a: 255 },
        position: "middle-center",
      })) as { image: ImageValue };
      const out = await readPixels(result.image);
      const b = getAlphaBounds(out);
      expect(b).not.toBeNull();
      const px = getPixelWithHighestAlphaInBounds(out, b!);
      expect(px[0]!).toBeGreaterThan(170);
      expect(px[1]!).toBeLessThan(80);
      expect(px[2]!).toBeLessThan(80);
    });

    test("applies text color alpha to rendered pixels", async () => {
      const task = new ImageTextTask();
      const result = (await task.run({
        ...base,
        text: "M",
        fontSize: 72,
        color: "rgba(200, 10, 30, 0.25)",
        position: "middle-center",
      })) as { image: ImageValue };
      const out = await readPixels(result.image);

      expect(getMaxAlpha(out)).toBeGreaterThan(20);
      expect(getMaxAlpha(out)).toBeLessThanOrEqual(76);
    });

    test("larger font size paints more pixels than a smaller one", async () => {
      const task = new ImageTextTask();
      const smallResult = (await task.run({
        ...base,
        fontSize: 14,
        position: "middle-center",
      })) as { image: ImageValue };
      const largeResult = (await task.run({
        ...base,
        fontSize: 42,
        position: "middle-center",
      })) as { image: ImageValue };
      const small = await readPixels(smallResult.image);
      const large = await readPixels(largeResult.image);
      expect(countTextishPixels(large)).toBeGreaterThan(countTextishPixels(small));
    });

    test("renders onto an existing background image", async () => {
      const task = new ImageTextTask();
      const bg = toImageValue(createTestImage(160, 160, 3, [40, 80, 120]));
      const result = (await task.run({
        ...baseWithBackground,
        image: bg,
        position: "bottom-right",
      })) as { image: ImageValue };
      const out = await readPixels(result.image);

      expect(out.width).toBe(160);
      expect(out.height).toBe(160);
      expect(out.channels).toBe(4);
      expect(getPixel(out, 0, 0)).toEqual([40, 80, 120, 255]);
    });

    test("renders text over a background image using the image dimensions", async () => {
      const task = new ImageTextTask();
      const bg = toImageValue(createTestImage(96, 64, 3, [40, 80, 120]));
      const result = (await task.run({
        text: base.text,
        font: base.font,
        fontSize: base.fontSize,
        bold: base.bold,
        italic: base.italic,
        color: base.color,
        image: bg,
        position: "bottom-right",
      })) as { image: ImageValue };
      const out = await readPixels(result.image);

      expect(out.width).toBe(96);
      expect(out.height).toBe(64);
      expect(out.channels).toBe(4);
      expect(getPixel(out, 0, 0)).toEqual([40, 80, 120, 255]);
    });
  });

  // Decoding is held to the pixel budget; an image a task builds is held to the same
  // one, or a 1x1 image resized to 100000 wide asks for a 40 GB buffer.
  describe("output pixel budget", () => {
    const tiny = () => toImageValue(createTestImage(1, 1, 3, [1, 2, 3]));
    const side = (T: { inputSchema(): unknown }, port: string) =>
      (T.inputSchema() as { properties: Record<string, { maximum?: number }> }).properties[port]
        ?.maximum;

    test("resize states a per-side maximum and refuses past it", async () => {
      expect(side(ImageResizeTask, "width")).toBe(16384);
      expect(side(ImageResizeTask, "height")).toBe(16384);
      await expect(
        new ImageResizeTask().run({ image: tiny(), width: 16385, height: 1 })
      ).rejects.toThrow();
    });

    test("resize refuses an output over the pixel budget before building it", async () => {
      const err = await new ImageResizeTask()
        .run({ image: tiny(), width: 16384, height: 16384 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TaskInvalidInputError);
      expect(String((err as Error).message)).toMatch(/16384x16384/);
    });

    test("resize with fit outside is held to the size it can grow to", async () => {
      // "outside" keeps the aspect ratio and covers both targets: 1x100 to 10000x1
      // grows to 10000x1000000.
      const tall = toImageValue(createTestImage(1, 100, 3, [1, 2, 3]));
      await expect(
        new ImageResizeTask().run({ image: tall, width: 10000, height: 1, fit: "outside" })
      ).rejects.toBeInstanceOf(TaskInvalidInputError);
    });

    test("border states a maximum and refuses an output over the budget", async () => {
      expect(side(ImageBorderTask, "borderWidth")).toBe(8192);
      const err = await new ImageBorderTask()
        .run({ image: tiny(), borderWidth: 8000 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TaskInvalidInputError);
      expect(String((err as Error).message)).toMatch(/16001x16001/);
    });
  });
});
