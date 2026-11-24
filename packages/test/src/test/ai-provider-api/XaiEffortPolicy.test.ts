/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_EFFORTS } from "@workglow/ai";
import type { XaiModelConfig } from "@workglow/xai/ai";
import { getXaiReasoningEffort, XAI, xaiEffortPolicy } from "@workglow/xai/ai";
import { describe, expect, it } from "vitest";

function cfg(model_name: string, extra?: Partial<XaiModelConfig>): XaiModelConfig {
  return {
    provider: XAI,
    provider_config: { model_name },
    ...extra,
  } as XaiModelConfig;
}

describe("xaiEffortPolicy", () => {
  it("returns no levels for an unrecognized id and for an absent one", () => {
    expect(xaiEffortPolicy(cfg(""))).toEqual({ supported: [], default: undefined });
    expect(xaiEffortPolicy(cfg("llama-3-70b"))?.supported).toEqual([]);
  });

  it("treats reasoning Grok ids as all six with default medium", () => {
    expect(xaiEffortPolicy(cfg("grok-4"))).toEqual({
      supported: [...MODEL_EFFORTS],
      default: "medium",
    });
  });

  it("returns no levels for image and non-reasoning Grok ids", () => {
    expect(xaiEffortPolicy(cfg("grok-4-fast-non-reasoning"))?.supported).toEqual([]);
    expect(xaiEffortPolicy(cfg("grok-2-image-1212"))?.supported).toEqual([]);
  });
});

describe("getXaiReasoningEffort", () => {
  it("lets native provider_config.reasoning_effort win over model.effort", () => {
    expect(
      getXaiReasoningEffort(
        cfg("grok-4", {
          effort: "ultra",
          provider_config: { model_name: "grok-4", reasoning_effort: "low" },
        })
      )
    ).toBe("low");
  });

  it("maps extra and ultra to high", () => {
    expect(getXaiReasoningEffort(cfg("grok-4", { effort: "extra" }))).toBe("high");
    expect(getXaiReasoningEffort(cfg("grok-4", { effort: "ultra" }))).toBe("high");
  });

  it("returns undefined when neither native nor effort is set", () => {
    expect(getXaiReasoningEffort(cfg("grok-4"))).toBeUndefined();
  });

  it("does not map model.effort when the policy supports no levels", () => {
    expect(
      getXaiReasoningEffort(cfg("grok-4-fast-non-reasoning", { effort: "high" }))
    ).toBeUndefined();
    expect(getXaiReasoningEffort(cfg("grok-2-image-1212", { effort: "ultra" }))).toBeUndefined();
  });

  it("honours effort_options even when the class policy would allow the effort", () => {
    expect(
      getXaiReasoningEffort(cfg("grok-4", { effort: "high", effort_options: [] }))
    ).toBeUndefined();
  });

  it("still sends a native reasoning_effort on a non-reasoning id", () => {
    expect(
      getXaiReasoningEffort(
        cfg("grok-4-fast-non-reasoning", {
          effort: "high",
          provider_config: {
            model_name: "grok-4-fast-non-reasoning",
            reasoning_effort: "low",
          },
        })
      )
    ).toBe("low");
  });
});

describe("the levels each current Grok model takes", () => {
  it("offers Grok 4.6 and 4.7 no none, defaults them to high, and sends extra and ultra as xhigh", () => {
    for (const name of ["grok-4.7", "grok-4.6"]) {
      expect(xaiEffortPolicy(cfg(name))).toEqual({
        supported: ["low", "medium", "high", "extra", "ultra"],
        default: "high",
      });
      expect(getXaiReasoningEffort(cfg(name, { effort: "extra" }))).toBe("xhigh");
      expect(getXaiReasoningEffort(cfg(name, { effort: "ultra" }))).toBe("xhigh");
      expect(getXaiReasoningEffort(cfg(name, { effort: "none" }))).toBeUndefined();
    }
  });

  it("sends Grok 4.5's extra and ultra as high, its top level", () => {
    expect(xaiEffortPolicy(cfg("grok-4.5"))?.supported).not.toContain("none");
    expect(getXaiReasoningEffort(cfg("grok-4.5", { effort: "ultra" }))).toBe("high");
  });

  it("lets Grok 4.3 turn reasoning off, and defaults it to low", () => {
    expect(xaiEffortPolicy(cfg("grok-4.3"))).toEqual({
      supported: ["none", "low", "medium", "high", "extra", "ultra"],
      default: "low",
    });
    expect(getXaiReasoningEffort(cfg("grok-4.3", { effort: "none" }))).toBe("none");
    expect(getXaiReasoningEffort(cfg("grok-4.3", { effort: "extra" }))).toBe("high");
  });

  it("passes a native xhigh through", () => {
    expect(
      getXaiReasoningEffort(
        cfg("grok-4.7", { provider_config: { model_name: "grok-4.7", reasoning_effort: "xhigh" } })
      )
    ).toBe("xhigh");
  });
});
