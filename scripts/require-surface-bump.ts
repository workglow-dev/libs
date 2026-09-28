#!/usr/bin/env bun
/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Refuses a release whose version number stays inside the previous version's
 * caret range while a published declaration changed underneath it.
 *
 * `require-green-ci` cannot see this. Every implementer inside the repo is
 * fixed in the commit that changes the interface, so the tree is green; the
 * classes that stop compiling are downstream, and they pick the change up
 * without asking because a patch is inside their range. So this compares what
 * they actually compile against — the declarations reachable from each
 * `exports` entry of the freshly built `dist` — with the same from the version
 * last published, one top-level declaration at a time (see
 * `lib/surfaceGate.ts` for what is reachable and what counts as a change).
 *
 * It runs BEFORE `bunset` and reads the release from `bunset --dry-run`,
 * because `bunset` commits, tags, pushes and cuts a GitHub release in one
 * step: a refusal after it would leave a pushed tag for a version that never
 * reaches npm. The declarations do not depend on the version number, so the
 * `dist` that `rebuild` just wrote is already the one `publish-workspaces`
 * packs. `--from-tree` reads the versions and changelog entries already written
 * instead, for re-checking a release whose `bunset` step has run.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { findSourceStubs } from "./lib/sourceStubs";
import {
  buildPublicSurface,
  diffSurfaces,
  evaluateSurfaceBump,
  formatSurfaceRefusal,
  parseBunsetDryRun,
  previousPublishedVersion,
  readChangelogEntry,
  typeEntryPoints,
  type PackageSurface,
  type PlannedRelease,
  type SurfaceBumpVerdict,
  type SurfaceChange,
} from "./lib/surfaceGate";
import { findWorkspaces } from "./lib/util";

/** Escape hatch, for a surface change that is deliberately not a break. */
const OVERRIDE = "WORKGLOW_SKIP_SURFACE_GATE";

/** npm round trips in flight at once. */
const CONCURRENCY = 8;

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  console.error(
    `  This gate exists because \`putByUniqueKey\` was added to \`ITabularStorage\`\n` +
      `  in a patch, and every downstream class implementing it stopped compiling.\n` +
      `  Declare the break with a \`feat!:\` commit (or a BREAKING CHANGE footer) so\n` +
      `  bunset takes the minor, or, if nothing downstream can break, set\n` +
      `  ${OVERRIDE}=1 — deliberately, and say why in the release notes.\n`
  );
  process.exit(1);
}

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly missing: boolean;
}

function run(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data.toString()));
    child.stderr.on("data", (data) => (stderr += data.toString()));
    child.on("error", (error) => {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      resolve({ status: null, stdout, stderr: stderr || error.message, missing });
    });
    child.on("close", (status) => resolve({ status, stdout, stderr, missing: false }));
  });
}

interface Workspace {
  readonly dir: string;
  readonly name: string;
  readonly version: string;
}

async function publishableWorkspaces(): Promise<Map<string, Workspace>> {
  const byName = new Map<string, Workspace>();
  for (const dir of await findWorkspaces()) {
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf-8")) as {
      readonly name: string;
      readonly version: string;
    };
    byName.set(manifest.name, { dir, name: manifest.name, version: manifest.version });
  }
  return byName;
}

function planFromBunset(): PlannedRelease[] {
  const result = spawnSync(process.execPath, ["x", "bunset", "--dry-run"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    fail(
      `\`bunset --dry-run\` failed, so the release it would cut is unknown:\n` +
        `${(result.stdout + result.stderr).trim()}`
    );
  }
  const plan = parseBunsetDryRun(result.stdout);
  if (plan.length === 0) {
    fail(
      `\`bunset --dry-run\` printed no \`name: old → new (bump)\` lines. Either its ` +
        `output format changed or it plans no release:\n${result.stdout.slice(0, 500)}`
    );
  }
  return plan;
}

async function planFromTree(workspaces: ReadonlyMap<string, Workspace>): Promise<PlannedRelease[]> {
  const plan: PlannedRelease[] = [];
  for (const ws of workspaces.values()) {
    const changelogPath = join(ws.dir, "CHANGELOG.md");
    const changelog = existsSync(changelogPath) ? await readFile(changelogPath, "utf-8") : "";
    plan.push({
      name: ws.name,
      nextVersion: ws.version,
      changelogEntry: readChangelogEntry(changelog, ws.version),
    });
  }
  return plan;
}

/** Every published version, or `undefined` for a package npm has never seen. */
async function publishedVersions(name: string): Promise<string[] | undefined> {
  const result = await run("npm", ["view", name, "versions", "--json"]);
  if (result.missing) fail("`npm` is not installed, so the published versions cannot be read.");
  if (result.status !== 0) {
    if (/E404|404 Not Found/.test(result.stderr + result.stdout)) return undefined;
    throw new Error(`\`npm view ${name} versions\` failed: ${result.stderr.trim()}`);
  }
  const parsed = JSON.parse(result.stdout) as string | string[];
  return typeof parsed === "string" ? [parsed] : parsed;
}

/** A package's public declarations, whether built locally or unpacked from a tarball. */
async function readSurface(
  root: string
): Promise<{ readonly surface: PackageSurface; readonly declarationFiles: number }> {
  const files = new Map<string, string>();
  if (existsSync(join(root, "dist"))) {
    for await (const path of new Glob("dist/**/*.d.ts").scan({ cwd: root })) {
      files.set(path, await readFile(join(root, path), "utf-8"));
    }
  }
  // Each side's own manifest: an entry point added or dropped between the two
  // versions is part of what changed.
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf-8")) as Parameters<
    typeof typeEntryPoints
  >[0];
  const entries = typeEntryPoints(manifest, files);
  // No entries is a real answer — a bin-only package has nothing to import.
  return { surface: buildPublicSurface(files, entries), declarationFiles: files.size };
}

async function publishedSurface(
  name: string,
  version: string,
  scratch: string
): Promise<PackageSurface> {
  const dir = await mkdtemp(join(scratch, "pkg-"));
  const packed = await run("npm", [
    "pack",
    `${name}@${version}`,
    "--pack-destination",
    dir,
    "--json",
  ]);
  if (packed.status !== 0) {
    throw new Error(`\`npm pack ${name}@${version}\` failed: ${packed.stderr.trim()}`);
  }
  const [tarball] = JSON.parse(packed.stdout) as { readonly filename: string }[];
  if (tarball === undefined) throw new Error(`\`npm pack ${name}@${version}\` returned nothing.`);
  const extracted = join(dir, "x");
  await mkdir(extracted);
  const untar = await run("tar", ["-xzf", join(dir, tarball.filename), "-C", extracted]);
  if (untar.status !== 0) {
    throw new Error(`Could not extract ${tarball.filename}: ${untar.stderr.trim()}`);
  }
  return (await readSurface(join(extracted, "package"))).surface;
}

interface Checked {
  readonly name: string;
  readonly line: string;
  /** Names now re-exported from another package in this run, for the reviewer. */
  readonly moved: readonly string[];
  readonly verdict: SurfaceBumpVerdict;
}

async function checkPackage(
  release: PlannedRelease,
  workspace: Workspace,
  scratch: string,
  guarded: ReadonlySet<string>
): Promise<Checked> {
  const versions = await publishedVersions(release.name);
  if (versions?.includes(release.nextVersion)) {
    return {
      name: release.name,
      line: `${release.nextVersion} already published, not part of this release`,
      moved: [],
      verdict: { ok: true, why: "already-published" },
    };
  }
  const previousVersion =
    versions === undefined ? undefined : previousPublishedVersion(versions, release.nextVersion);
  if (previousVersion === undefined) {
    return {
      name: release.name,
      line: `nothing published below ${release.nextVersion}`,
      moved: [],
      verdict: { ok: true, why: "unpublished" },
    };
  }

  const local = await readSurface(workspace.dir);
  if (local.declarationFiles === 0) {
    throw new Error(`${release.name} has no dist/**/*.d.ts — run \`bun run rebuild\` first.`);
  }
  const previous = await publishedSurface(release.name, previousVersion, scratch);
  const changes = diffSurfaces(previous, local.surface, guarded);
  const verdict = evaluateSurfaceBump({
    name: release.name,
    previousVersion,
    nextVersion: release.nextVersion,
    changes,
    changelogEntry: release.changelogEntry,
  });
  const count = (kind: SurfaceChange["kind"]): number =>
    changes.filter((c) => c.kind === kind).length;
  const moved = new Map<string, string>();
  for (const c of changes) if (c.kind === "moved") moved.set(c.name, c.to);
  return {
    name: release.name,
    line:
      `${previousVersion} → ${release.nextVersion}: ` +
      `${count("changed") + count("removed")} changed/removed, ${count("added")} added, ` +
      `${moved.size} moved`,
    moved: [...moved].map(([name, to]) => `moved ${name} → re-exported from "${to}"`),
    verdict,
  };
}

async function mapConcurrently<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main(): Promise<void> {
  if (process.env[OVERRIDE] === "1") {
    console.warn(`⚠ ${OVERRIDE}=1 — publishing without comparing published declarations.`);
    return;
  }

  const workspaces = await publishableWorkspaces();

  // A stubbed dist would diff as every declaration removed. `publish-workspaces`
  // refuses these too; saying so here names the actual cause.
  for (const ws of workspaces.values()) {
    const stubs = await findSourceStubs(ws.dir);
    if (stubs.length > 0) {
      fail(`${ws.name} has source-mode stubs in dist — run \`bun run use-dist\` first.`);
    }
  }

  const plan = process.argv.includes("--from-tree")
    ? await planFromTree(workspaces)
    : planFromBunset();
  // Private packages are versioned in lockstep but never published.
  const releases = plan.filter((r) => workspaces.has(r.name));
  const guarded = new Set(releases.map((r) => r.name));

  const scratch = await mkdtemp(join(tmpdir(), "workglow-surface-"));
  let checked: Checked[] | Error;
  try {
    checked = await mapConcurrently(releases, CONCURRENCY, (r) =>
      checkPackage(r, workspaces.get(r.name)!, scratch, guarded)
    );
  } catch (error) {
    checked = error instanceof Error ? error : new Error(String(error));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  // A registry that cannot be read refuses rather than passes: "npm was down"
  // must not be a way past the gate.
  if (checked instanceof Error) fail(checked.message);

  for (const c of checked) {
    console.log(`  ${c.name} ${c.line}`);
    for (const line of c.moved) console.log(`    ${line}`);
  }

  const refusals = checked.flatMap((c) => (c.verdict.ok ? [] : [c.verdict]));
  if (refusals.length > 0) {
    fail(
      `Published declarations changed in a release that stays inside the previous ` +
        `version's caret range, and no changelog entry declares Breaking Changes:\n\n` +
        formatSurfaceRefusal(refusals)
    );
  }

  console.log(
    `✔ No published declaration changed or disappeared below the break slot ` +
      `(${checked.length} packages checked).`
  );
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
