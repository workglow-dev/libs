/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { GEMINI_API_VERSION } from "../../../../../providers/google-gemini/src/ai/common/Gemini_Constants";

describe("GEMINI_API_VERSION", () => {
  it("stays on v1beta: v1 rejects thinkingConfig and googleSearch on 2.5 models", () => {
    expect(GEMINI_API_VERSION).toBe("v1beta");
  });
});
