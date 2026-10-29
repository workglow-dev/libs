/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bundles the provider with `__TFMP_WASM_VERSIONS__` defined as the installed
 * version of each `@mediapipe/tasks-*` SDK, so the default jsDelivr WASM URLs
 * name the same release as the JS SDK they load into. Extra arguments
 * (`--watch --no-clear-screen`) pass through to `bun build`.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const SDKS = {
  vision: "@mediapipe/tasks-vision",
  text: "@mediapipe/tasks-text",
  audio: "@mediapipe/tasks-audio",
  genai: "@mediapipe/tasks-genai",
} as const;

const requireFromPackage = createRequire(join(import.meta.dir, "package.json"));

/** The SDKs' `exports` maps do not expose `./package.json`, so read the one beside the entry. */
function installedVersion(sdk: string): string {
  const entry = requireFromPackage.resolve(sdk);
  const pkg = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as {
    readonly version: string;
  };
  return pkg.version;
}

const versions = Object.fromEntries(
  Object.entries(SDKS).map(([engine, sdk]) => [engine, installedVersion(sdk)])
);

const proc = Bun.spawn(
  [
    "bun",
    "build",
    "--target=browser",
    "--sourcemap=external",
    "--packages=external",
    "--root",
    "./src",
    "--outdir",
    "./dist",
    "--define",
    `__TFMP_WASM_VERSIONS__=${JSON.stringify(versions)}`,
    ...process.argv.slice(2),
    "./src/ai.ts",
    "./src/ai-runtime.ts",
  ],
  { cwd: import.meta.dir, stdio: ["inherit", "inherit", "inherit"] }
);
process.exit(await proc.exited);
