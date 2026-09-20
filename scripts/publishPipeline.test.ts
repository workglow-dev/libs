/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./lib/testDiscovery";

/**
 * The wiring that decides whether anything ever exercises the BUILT BUNDLES.
 *
 * Every vitest project attaches the source-resolving plugin, so a run that does
 * not ask for the `dist` target resolves `@workglow/*` to `src` and the bundles
 * are never loaded at all. The `test-vitest-dist` CI job is the one caller that
 * asks for it, and `publish-all` reaches it through `require-green-ci`, which
 * requires this same workflow green for HEAD before anything is versioned or
 * pushed.
 *
 * Read as TEXT, on purpose. Importing the manifest would answer "what does the
 * JSON parse to", which is not the question: the question is whether the shell
 * command a human reads names the script. And the workflow is YAML that this
 * repo has no parser for, so treating it as text keeps the guard dependency-free
 * and lets it assert the ABSENCE of a key, which a parse would have to walk the
 * whole document to do.
 */
describe("dist-target wiring", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const workflow = readFileSync(join(ROOT, ".github/workflows/test.yml"), "utf8");

  it("defines the dist target inside the script, not at the call site", () => {
    // The variable is what makes the run mean anything, and no in-process
    // assertion can notice it went missing: `resolveTestTarget(undefined)`
    // returns "source", so a run stripped of it is a silent, green rerun of the
    // source job. Setting it in the script is the structural fix — dropping it
    // now requires deleting the script call, which the two checks below catch.
    const script = manifest.scripts["test:vitest:dist"];
    expect(script).toBeDefined();
    expect(script).toContain("WORKGLOW_TEST_TARGET=dist");
  });

  it("gates publishing on the CI run that covers the bundles", () => {
    // `publish-all` runs no suite itself: it requires this workflow green for
    // HEAD instead. That delegation only covers the bundles while the dist job
    // is part of the workflow, and before the version bump — after `bunset`,
    // HEAD names a commit no workflow has seen.
    const publish = manifest.scripts["publish-all"];
    expect(publish).toBeDefined();
    expect(publish).toContain("require-green-ci");
    expect(publish!.indexOf("require-green-ci")).toBeLessThan(publish!.indexOf("bunset"));
    expect(workflow).toContain("test-vitest-dist:");
  });

  it("has CI invoke the same script rather than restate the variable", () => {
    expect(workflow).toContain("bun run test:vitest:dist");
    // One definition of "the dist target". An inline `env:` block here is how
    // CI and `publish-all` drift apart, and how a workflow edit silently
    // demotes the bundle-integrity job to a duplicate source run.
    expect(workflow).not.toMatch(/^\s*WORKGLOW_TEST_TARGET:/m);
  });

  it("keeps the dist pass out of the concurrent all-suites script", () => {
    // `test:vitest:all` fans seven suites out at once; the dist pass measures
    // nothing they do not already cover under the source target, so adding it
    // there buys nothing and competes for the same cores.
    expect(manifest.scripts["test:vitest:all"]).not.toContain("test:vitest:dist");
  });
});
