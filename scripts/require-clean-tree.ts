#!/usr/bin/env bun
/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Refuses to continue unless the working tree still matches the commit whose
 * CI `require-green-ci` checked.
 *
 * It sits between `rebuild` and `bunset` in `publish-all`, where `format` and
 * `rebuild` have just run over a tree the gate found clean. On a commit CI
 * passed, both are no-ops: the `lint` job runs `format-check` over the same
 * glob `format` writes and `oxlint --deny-warnings` over the same source
 * `oxlint --fix` would fix, and `rebuild` only ever writes `dist`, which is
 * gitignored. So anything they change here is a file the green run never saw,
 * and `publish-workspaces` is about to pack it.
 *
 * Which makes this an assertion rather than a step: it states what CI already
 * covers, and fails the release if that stops being true instead of publishing
 * bytes no workflow has built.
 */
import { spawnSync } from "node:child_process";
import { readTreeState, summarizePaths } from "./lib/cleanTree";

/** The same escape hatch `require-green-ci` uses — a publish that skipped the
 * CI check has already accepted unverified bytes, so blocking it here would
 * refuse the release for a reason the operator already overrode. */
const OVERRIDE = "WORKGLOW_SKIP_CI_GATE";

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function main(): void {
  if (process.env[OVERRIDE] === "1") {
    console.warn(`⚠ ${OVERRIDE}=1 — publishing without checking the working tree.`);
    return;
  }

  const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  if (status.status !== 0) fail(`Could not read the working tree: ${status.stderr.trim()}`);

  const tree = readTreeState(status.stdout);
  if (!tree.clean) {
    fail(
      `\`format\` or \`rebuild\` changed the tree after the CI check passed:\n` +
        `${summarizePaths(tree.paths)}\n\n` +
        `  These bytes are not in the commit CI tested, and publishing would ship\n` +
        `  them. Commit them, let \`Build & Test\` finish, and re-run the release.\n` +
        `  To publish anyway, set ${OVERRIDE}=1 — deliberately, and say why in the\n` +
        `  release notes.`
    );
  }

  console.log("✔ Working tree still matches the commit whose CI was checked.");
}

main();
