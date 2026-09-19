/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelSearchTaskOutput } from "@workglow/ai";
import { CACTUS_CATALOG } from "@workglow/cactus/ai";
import { describe, expect, it } from "vitest";
import { runFnFor } from "./test-utils";

const Cactus_ModelSearch = runFnFor(["model.search"]);

describe("Cactus_ModelSearch", () => {
  it("emits a single finish with the catalog", async () => {
    let finishData: ModelSearchTaskOutput | undefined;
    const controller = new AbortController();
    await Cactus_ModelSearch(
      { provider: "LOCAL_CACTUS", query: "" } as any,
      undefined,
      controller.signal,
      (ev) => {
        if (ev.type === "finish") finishData = ev.data as ModelSearchTaskOutput;
      }
    );
    const ids = finishData?.results.map((r) => r.id) ?? [];
    expect(ids).toEqual(expect.arrayContaining(["needle-26m", "needle-v2", "needle-v3"]));
    // An empty query returns the whole catalog — assert against it rather than
    // a literal count, so adding a model does not fail an unrelated test.
    expect(ids).toEqual(CACTUS_CATALOG.map((entry) => entry.model_id));
    expect(finishData?.results[0].record.provider).toBe("LOCAL_CACTUS");
  });
});
