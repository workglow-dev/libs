/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { readTreeState, summarizePaths } from "./lib/cleanTree";

describe("readTreeState", () => {
  it("reads an empty status as clean", () => {
    // `git status --porcelain` on a clean tree prints nothing at all; the
    // trailing newline of a non-empty one must not read as a nameless change
    // either, or every refusal would list one blank path.
    expect(readTreeState("")).toEqual({ clean: true, paths: [] });
    expect(readTreeState("\n")).toEqual({ clean: true, paths: [] });
  });

  it("names each changed path, whatever its status letters", () => {
    const state = readTreeState(" M packages/ai/src/job/AiJob.ts\n?? scripts/new.ts\nA  a.ts\n");
    expect(state.clean).toBe(false);
    expect(state.paths).toEqual(["packages/ai/src/job/AiJob.ts", "scripts/new.ts", "a.ts"]);
  });

  it("takes the destination of a rename, since that is the file that would be packed", () => {
    const state = readTreeState("R  scripts/old.ts -> scripts/new.ts\n");
    expect(state.paths).toEqual(["scripts/new.ts"]);
  });

  it("does not split a path that merely contains an arrow", () => {
    // Only the LAST ` -> ` separates the pair, so a file whose own name carries
    // one is reported whole rather than truncated to its own suffix.
    expect(readTreeState(" M a -> b.ts\n").paths).toEqual(["b.ts"]);
    expect(readTreeState("R  a -> b.ts -> c.ts\n").paths).toEqual(["c.ts"]);
  });
});

describe("summarizePaths", () => {
  it("lists every path when they fit", () => {
    expect(summarizePaths(["a.ts", "b.ts"])).toBe("    a.ts\n    b.ts");
  });

  it("counts what it elides, so the operator knows the list is partial", () => {
    const summary = summarizePaths(["a", "b", "c"], 2);
    expect(summary).toBe("    a\n    b\n    … and 1 more");
  });
});
