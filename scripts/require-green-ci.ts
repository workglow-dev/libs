#!/usr/bin/env bun
/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Refuses to continue unless `Build & Test` is green for the commit at HEAD
 * and the working tree is that commit.
 *
 * This is the whole test gate. Re-running a slice locally would repeat, on the
 * publisher's machine, work the checked run already did on this exact commit —
 * and the commit is what consumers install, not the working tree. It is also
 * the half a `--no-verify`-style shortcut cannot walk around: the answer comes
 * from GitHub rather than from the machine doing the publishing.
 *
 * It is the FIRST step of `publish-all`, deliberately, and every later step is
 * a reason:
 *
 * - `bunset` writes and pushes the release commit. After it, HEAD names
 *   something no workflow has ever seen, and a push of a pure version bump
 *   starts a full build of a tree nobody is waiting on — paid for before
 *   anyone knows whether the release may proceed at all.
 * - `format` and `rebuild` write to the tree. Running them first means the run
 *   this checks covers the pre-format commit while `publish-workspaces` packs
 *   the post-format tree, so the thing tested and the thing published are two
 *   trees by construction.
 *
 * Reading the commit is only worth anything while the tree still IS that
 * commit, which is why a dirty tree is refused here rather than noted. What
 * `format` and `rebuild` do to the tree afterwards is `require-clean-tree`'s
 * question.
 */
import { spawnSync } from "node:child_process";
import { evaluateCiRuns, type WorkflowRun } from "./lib/ciGate";
import { readTreeState, summarizePaths } from "./lib/cleanTree";

/** Escape hatch, for a machine with no `gh` or an offline publish. */
const OVERRIDE = "WORKGLOW_SKIP_CI_GATE";
const WORKFLOW = "test.yml";

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  console.error(
    `  This gate exists because \`publish-all\` lost its test steps inside a\n` +
      `  \`chore: update deps\` commit and three releases went out ungated.\n` +
      `  To publish anyway, set ${OVERRIDE}=1 — deliberately, and say why in the\n` +
      `  release notes.\n`
  );
  process.exit(1);
}

function main(): void {
  if (process.env[OVERRIDE] === "1") {
    console.warn(`⚠ ${OVERRIDE}=1 — publishing without checking CI for this commit.`);
    return;
  }

  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0) fail(`Could not read HEAD: ${head.stderr.trim()}`);
  const sha = head.stdout.trim();

  // Before the network round trip, because a tree that is not its commit makes
  // the answer meaningless whatever it turns out to be: the run would cover
  // HEAD while `publish-workspaces` packs whatever is on disk.
  const dirty = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  if (dirty.status !== 0) fail(`Could not read the working tree: ${dirty.stderr.trim()}`);
  const tree = readTreeState(dirty.stdout);
  if (!tree.clean) {
    fail(
      `Working tree is not clean, so the CI status for ${sha.slice(0, 7)} does not ` +
        `describe what would be published:\n${summarizePaths(tree.paths)}\n\n` +
        `  Commit the changes and let CI finish, or stash them.`
    );
  }

  const listed = spawnSync(
    "gh",
    [
      "run",
      "list",
      "--commit",
      sha,
      "--workflow",
      WORKFLOW,
      "--json",
      "databaseId,status,conclusion,url",
    ],
    { encoding: "utf8" }
  );

  // A missing `gh` refuses rather than warns. Warning would make "no gh
  // installed" a silent way past the gate, which is the failure this replaces.
  if (listed.error !== undefined && (listed.error as NodeJS.ErrnoException).code === "ENOENT") {
    fail(`\`gh\` is not installed, so the CI status for ${sha} cannot be read.`);
  }
  if (listed.status !== 0) fail(`\`gh run list\` failed: ${listed.stderr.trim()}`);

  let runs: WorkflowRun[];
  try {
    runs = JSON.parse(listed.stdout) as WorkflowRun[];
  } catch {
    fail(`\`gh run list\` returned output that is not JSON: ${listed.stdout.slice(0, 200)}`);
  }

  const verdict = evaluateCiRuns(runs, sha);
  if (!verdict.ok) fail(verdict.reason);

  // Says what was actually checked, so a green line in the publish log is
  // evidence rather than reassurance.
  console.log(`✔ Build & Test is green for ${sha}: ${verdict.run.url}`);
}

main();
