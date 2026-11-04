/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Guards the *published* contract of `@workglow/bootstrap`.
 *
 * The vitest harness bootstraps from the package's raw source, and the only
 * other consumer of its build output is the meta-package's export-collision
 * detector. So nothing else in CI would notice a typo in the `exports` map or a
 * `build-*` script that silently emitted no file — `import { bootstrapWorkglow }
 * from "@workglow/bootstrap"` would throw ERR_PACKAGE_PATH_NOT_EXPORTED for
 * consumers with no prior signal.
 *
 * Requires a build (CI's `test-vitest-unit` job downloads the `build-output`
 * artifact); `bun run use-source` stubs satisfy it too.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const PACKAGE_DIR = join(REPO_ROOT, "packages/bootstrap");

/** The `exports` map's leaves are relative target paths; its branches are condition objects. */
type ExportsNode = string | { readonly [condition: string]: ExportsNode };

interface BootstrapPackageJson {
  readonly name: string;
  readonly exports: Record<string, ExportsNode>;
}

/** Every leaf string reachable in the exports map, paired with the condition path that reaches it. */
function collectExportTargets(
  node: ExportsNode,
  path: readonly string[] = []
): { readonly path: readonly string[]; readonly target: string }[] {
  if (typeof node === "string") return [{ path, target: node }];
  return Object.entries(node).flatMap(([condition, child]) =>
    collectExportTargets(child, [...path, condition])
  );
}

/** Resolves a subpath the way a plain Node `import` does: no react-native/browser/bun condition. */
function resolveNodeImport(node: ExportsNode): string | undefined {
  if (typeof node === "string") return node;
  for (const [condition, child] of Object.entries(node)) {
    if (condition === "react-native" || condition === "browser" || condition === "bun") continue;
    if (condition === "types") continue;
    if (condition === "import" || condition === "default" || condition === "node") {
      const resolved = resolveNodeImport(child);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}

let pkg: BootstrapPackageJson;

beforeAll(async () => {
  pkg = JSON.parse(await readFile(join(PACKAGE_DIR, "package.json"), "utf8"));
});

describe("@workglow/bootstrap published exports", () => {
  it("declares an exports map", () => {
    expect(pkg.name).toBe("@workglow/bootstrap");
    expect(Object.keys(pkg.exports).length).toBeGreaterThan(0);
  });

  it("points every exports-map target at a file that exists", () => {
    const missing = Object.entries(pkg.exports)
      .flatMap(([subpath, node]) =>
        collectExportTargets(node).map((entry) => ({ subpath, ...entry }))
      )
      .filter(({ target }) => !existsSync(join(PACKAGE_DIR, target)))
      .map(({ subpath, path, target }) => `"${subpath}" [${path.join(".")}] -> ${target}`);

    expect(missing).toEqual([]);
  });

  it("exposes the bootstrap API from the resolved node entry point", async () => {
    const target = resolveNodeImport(pkg.exports["."]!);
    expect(target).toBeDefined();

    // Imported by file URL rather than by the `@workglow/bootstrap` specifier:
    // the isolated linker keeps workspace packages out of the repo root's
    // node_modules, so the bare specifier does not resolve from here.
    const entryUrl = pathToFileURL(join(PACKAGE_DIR, target!)).href;
    const mod: Record<string, unknown> = await import(/* @vite-ignore */ entryUrl);

    expect(Object.keys(mod)).toEqual(
      expect.arrayContaining([
        "bootstrapWorkglow",
        "createOrchestrationContext",
        "registerAllDefaults",
      ])
    );
    expect(typeof mod.bootstrapWorkglow).toBe("function");
  });
});
