/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const workflowDir = join(repoRoot, ".github", "workflows");

/**
 * Every `setup-bun` step reads the one pinned version, and the pin agrees with
 * `packageManager`.
 *
 * A number repeated at every step is a pin only where someone remembered to
 * change it: it stood at 1.4.2 in one job and 1.4.0 in the other twelve, so
 * `engines` and `packageManager` described a Bun that nothing in CI ran the
 * suite on. Reading `.bun-version` is what makes the claim and the mechanism
 * the same thing.
 *
 * The one exception is the `latest` axis of the nightly parity matrix, which
 * exists precisely to run a Bun the repo has not pinned; that workflow is
 * informational and blocks no merge.
 */
describe("Bun is pinned in one place", () => {
  const workflows = readdirSync(workflowDir).filter(
    (name) => name.endsWith(".yml") || name.endsWith(".yaml")
  );

  it("has workflows to check", () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  it("names no Bun version inline outside the nightly parity matrix", () => {
    const inline: string[] = [];
    for (const name of workflows) {
      const text = readFileSync(join(workflowDir, name), "utf8");
      for (const [index, line] of text.split("\n").entries()) {
        const match = /^\s*bun-version:\s*(\S+)\s*$/.exec(line);
        if (match === null) continue;
        if (name === "nightly-bun-parity.yml" && match[1] === "latest") continue;
        inline.push(`${name}:${index + 1} → ${match[1]}`);
      }
    }

    expect(
      inline,
      "these steps pin Bun inline instead of reading .bun-version, which is how the " +
        "pin drifted apart across jobs in the first place"
    ).toEqual([]);
  });

  it("agrees with packageManager", () => {
    const pinned = readFileSync(join(repoRoot, ".bun-version"), "utf8").trim();
    const { packageManager } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      packageManager: string;
    };

    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageManager).toBe(`bun@${pinned}`);
  });

  it("is a Bun the declared engine floor admits", () => {
    const pinned = readFileSync(join(repoRoot, ".bun-version"), "utf8").trim();
    const { engines } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      engines: { bun: string };
    };

    const floor = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(engines.bun);
    expect(floor, `engines.bun is "${engines.bun}", which this check cannot read`).not.toBeNull();
    const asNumbers = (value: string): number[] => value.split(".").map(Number);
    const [pinMajor, pinMinor, pinPatch] = asNumbers(pinned);
    const [, floorMajor, floorMinor, floorPatch] = floor!.map(Number);

    const pin = pinMajor! * 1e6 + pinMinor! * 1e3 + pinPatch!;
    const min = floorMajor! * 1e6 + floorMinor! * 1e3 + floorPatch!;
    expect(
      pin,
      `.bun-version ${pinned} is below engines.bun ${engines.bun}`
    ).toBeGreaterThanOrEqual(min);
  });
});
