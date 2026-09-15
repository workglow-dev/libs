/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const scripts = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

/**
 * `publish-all` is the release entry point, and it lost both of its test steps
 * inside a commit whose subject read `chore: update deps` — no body, nothing in
 * the diff summary naming the gate. Three releases and 126 package versions
 * were then cut through it before anyone noticed.
 *
 * A gate that can be deleted with nothing failing will be deleted again, so the
 * gate is asserted here rather than described in prose.
 *
 * The test gate is `require-green-ci` alone. Running a test slice locally as
 * well would re-run, on the publisher's machine, work the checked CI run
 * already did on that exact commit — minutes bought nothing, since the answer
 * is the same one and it is the commit, not the working tree, that consumers
 * install.
 *
 * Which is also why WHERE it runs is asserted and not only THAT it runs: the
 * answer is about a commit, so it is worth having only while the tree is still
 * that commit and only before anything pushes a new one.
 */
describe("the release gate on publish-all", () => {
  const publishAll = scripts["publish-all"] ?? "";

  it("checks the commit's CI run before it publishes", () => {
    // The commit is what everyone else gets, and a check that reads GitHub is
    // the half a `--no-verify`-style shortcut cannot walk around.
    expect(publishAll).toContain("require-green-ci");
  });

  it("gates first, before anything that writes or pushes", () => {
    // Order, not just presence. Each of these is a different failure:
    //
    // - after `bunset`: the check asks about a commit no workflow has seen —
    //   `bunset` wrote it — and passes for that reason. `bunset` also PUSHES,
    //   so a full build starts on a pure version bump before anyone knows
    //   whether the release may proceed.
    // - after `format` or `rebuild`: those write to the tree, so the run that
    //   was checked covers the pre-format commit while `publish-workspaces`
    //   packs the post-format tree.
    const gate = publishAll.indexOf("require-green-ci");
    expect(gate).toBeGreaterThan(-1);
    for (const later of ["format", "rebuild", "bunset", "publish-workspaces"]) {
      const at = publishAll.indexOf(later);
      expect(at).toBeGreaterThan(-1);
      expect(gate).toBeLessThan(at);
    }
  });

  it("re-asserts the clean tree after the steps that write to it", () => {
    // `format` and `rebuild` run on a tree the gate just found clean, and on a
    // commit CI passed both are no-ops — CI runs `format-check` over the same
    // glob, and `rebuild` only writes gitignored `dist`. Anything they change
    // is therefore a byte the green run never saw, one step before it would be
    // packed. The check has to sit after both and before `bunset`.
    const check = publishAll.indexOf("require-clean-tree");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(publishAll.indexOf("bun run format"));
    expect(check).toBeGreaterThan(publishAll.indexOf("rebuild"));
    expect(check).toBeLessThan(publishAll.indexOf("bunset"));
    expect(scripts["require-clean-tree"]).toBeDefined();
  });

  it("chains with && so a failing gate stops the publish", () => {
    // `;` or `&` would run the publish anyway. Nothing in the chain may use
    // either as a separator.
    expect(publishAll).not.toMatch(/;|(?<!&)&(?!&)/);
    expect(publishAll).toContain("publish-workspaces");
  });

  it("still names a script that exists", () => {
    // The gate is only as good as the script it calls: one that no longer
    // exists fails `publish-all` loudly, but one silently renamed would not be
    // caught by the string check above.
    expect(scripts["require-green-ci"]).toBeDefined();
  });
});
