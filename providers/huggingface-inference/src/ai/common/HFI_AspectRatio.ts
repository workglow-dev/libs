/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HfiImageDims } from "./HFI_ModelProfiles";
import { resolveHfiProfile } from "./HFI_ModelProfiles";

export type AspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4";

export interface ImageDims {
  width: number;
  height: number;
}

const FLUX_DIMS: Record<AspectRatio, ImageDims> = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1344, height: 768 },
  "9:16": { width: 768, height: 1344 },
  "4:3": { width: 1152, height: 896 },
  "3:4": { width: 896, height: 1152 },
};

const SDXL_DIMS: Record<AspectRatio, ImageDims> = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "4:3": { width: 1024, height: 768 },
  "3:4": { width: 768, height: 1024 },
};

const DIMS: Record<HfiImageDims, Record<AspectRatio, ImageDims>> = {
  flux: FLUX_DIMS,
  sdxl: SDXL_DIMS,
};

/** Resolves output dims for a model id and aspect ratio. Falls back to SDXL dims. */
export function resolveHfImageDims(modelId: string, aspectRatio: AspectRatio): ImageDims {
  const { profile } = resolveHfiProfile(modelId);
  return DIMS[profile.kind === "image" ? profile.dims : "sdxl"][aspectRatio];
}

/** Returns true if the model takes an inpainting mask. */
export function isHfInpaintingModel(modelId: string): boolean {
  const { profile } = resolveHfiProfile(modelId);
  return profile.kind === "image" && profile.masks;
}
