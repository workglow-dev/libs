/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ink, react and `@inkjs/ui` are loaded only when something is drawn to a
 * terminal. A process with no TTY — a piped run, a run reporting to the web
 * console, `mcp serve` — never draws, so it never pays for them.
 *
 * That holds only while no module the entry points import STATICALLY reaches
 * one of them: `ui/render.ts` forwards to `ui/inkRender.ts` through `import()`,
 * and one static import of `inkRender` (or of any component) from the command
 * tree puts the whole renderer back on the startup path without failing
 * anything else.
 */

const SRC = resolve(dirname(new URL(import.meta.url).pathname), "..");
const PACKAGE_JSON = resolve(SRC, "..", "package.json");
const ENTRIES = ["workglow.ts", "lib.ts", "human.ts"] as const;
const RENDERER = /^(ink|react|@inkjs\/ui)(\/.*)?$/;

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const stem = base.replace(/\.js$/, "");
  for (const candidate of [`${stem}.ts`, `${stem}.tsx`, `${base}/index.ts`, base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** Specifiers a module loads when it is evaluated: type-only and `import()` excluded. */
function staticSpecifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  // Anchored at column 0, so commented-out and JSDoc imports never match.
  const statement =
    /^(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+"([^"]+)"|^import\s+"([^"]+)"/gm;
  for (const match of source.matchAll(statement)) {
    const [, typeOnly, clause, from, bare] = match;
    if (bare !== undefined) {
      specifiers.push(bare);
      continue;
    }
    if (typeOnly) continue;
    const named = clause!.match(/^\{([\s\S]*)\}$/);
    const allInlineTypes =
      named !== null &&
      named[1]!
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .every((part) => part.startsWith("type "));
    if (!allInlineTypes) specifiers.push(from!);
  }
  // The automatic JSX runtime is an import nobody wrote.
  if (file.endsWith(".tsx")) specifiers.push("react/jsx-runtime");
  return specifiers;
}

interface StaticReach {
  readonly modules: ReadonlySet<string>;
  /** Each renderer package reached, with the import chain that reached it. */
  readonly renderer: ReadonlyMap<string, readonly string[]>;
}

function staticReach(entries: readonly string[]): StaticReach {
  const parent = new Map<string, string | undefined>();
  const renderer = new Map<string, readonly string[]>();
  const queue = entries.map((entry) => resolve(SRC, entry));
  for (const entry of queue) parent.set(entry, undefined);
  const chainTo = (file: string): string[] => {
    const chain: string[] = [];
    for (let at: string | undefined = file; at; at = parent.get(at)) {
      chain.unshift(relative(SRC, at));
    }
    return chain;
  };
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const specifier of staticSpecifiers(file)) {
      if (specifier.startsWith(".")) {
        const target = resolveRelative(file, specifier);
        if (target && !parent.has(target)) {
          parent.set(target, file);
          queue.push(target);
        }
      } else if (RENDERER.test(specifier) && !renderer.has(specifier)) {
        renderer.set(specifier, chainTo(file));
      }
    }
  }
  return { modules: new Set(parent.keys()), renderer };
}

describe("ink and react load lazily", () => {
  it("is reached by no entry point's static imports", () => {
    const { modules, renderer } = staticReach(ENTRIES);
    const chains = [...renderer].map(([pkg, chain]) => `${pkg} <- ${chain.join(" -> ")}`);
    expect(chains, "import it through ui/render.ts, which loads ui/inkRender.ts on use").toEqual(
      []
    );
    // Not vacuous: the facade is on the startup path and the renderer is not.
    expect(modules.has(resolve(SRC, "ui/render.ts"))).toBe(true);
    expect(modules.has(resolve(SRC, "ui/inkRender.ts"))).toBe(false);
  });

  it("is what ui/inkRender.ts reaches, so the walk above can see it", () => {
    const { renderer } = staticReach(["ui/inkRender.ts"]);
    expect([...renderer.keys()]).toEqual(expect.arrayContaining(["ink", "react"]));
  });

  it("stays in its own chunk in the bundles", () => {
    // Without code splitting, `bun build` inlines the `import()`ed module and
    // hoists its external imports to the top of the entry bundle, which loads
    // ink and react at startup however lazy the source is.
    const scripts = (
      JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    const entryBuilds = Object.entries(scripts).filter(
      ([, command]) =>
        command.startsWith("bun build") &&
        ENTRIES.some((entry) => command.includes(`./src/${entry}`))
    );
    expect(entryBuilds.map(([name]) => name).sort()).toEqual(
      ["build-human", "build-js", "build-lib", "dev-js", "dev-lib"].sort()
    );
    for (const [name, command] of entryBuilds) {
      expect(command, `${name} must pass --splitting`).toContain("--splitting");
    }
  });
});
