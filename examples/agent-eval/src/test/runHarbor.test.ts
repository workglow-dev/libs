/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { missingBundle } from "../run/runHarbor";

describe("missingBundle", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-eval-bundle-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const workglow = (kwargs: Record<string, unknown> = {}) => ({
    import_path: "workglow_agent:WorkglowAgent",
    kwargs,
  });

  it("accepts an arm's own bundle when the shared one was never built", () => {
    const own = join(dir, "custom.mjs");
    writeFileSync(own, "");
    expect(missingBundle([workglow({ bundle_path: own })], join(dir, "absent.mjs"))).toBe(
      undefined
    );
  });

  it("names an arm's own bundle that does not exist", () => {
    const shared = join(dir, "shared.mjs");
    writeFileSync(shared, "");
    expect(missingBundle([workglow({ bundle_path: join(dir, "nope.mjs") })], shared)).toMatch(
      /bundle_path .*nope\.mjs does not exist/
    );
  });

  it("asks for a build when an arm relies on the shared bundle and it is absent", () => {
    expect(missingBundle([workglow()], join(dir, "absent.mjs"))).toMatch(/build-agent/);
  });

  it("ignores arms that are not the workglow adapter", () => {
    expect(missingBundle([{ import_path: "pi:Pi" }], join(dir, "absent.mjs"))).toBe(undefined);
  });
});
