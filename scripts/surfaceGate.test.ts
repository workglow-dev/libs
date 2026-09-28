/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  buildPublicSurface,
  declaresBreakingChanges,
  diffSurfaces,
  evaluateSurfaceBump,
  excerptChange,
  formatSurfaceRefusal,
  isBelowBreakSlot,
  normalizeDeclarations,
  parseBunsetDryRun,
  parseModule,
  previousPublishedVersion,
  readChangelogEntry,
  resolveModule,
  typeEntryPoints,
  type PackageSurface,
  type SurfaceChange,
} from "./lib/surfaceGate";

const LIMITER_BEFORE = `/**
 * @license
 */
export declare const JOB_LIMITER: import("@workglow/util").ServiceToken<ILimiter>;
export type LimiterScope = "process" | "cluster";
/**
 * Interface for a job limiter.
 */
export interface ILimiter {
    readonly scope: LimiterScope;
    /** Atomic check-and-record. */
    tryAcquire(): Promise<unknown | null>;
    release(token: unknown): Promise<void>;
}
`;

// The 0.5.1 narrowing: the break is inside an interface body, on a line no
// top-level `export` scan would ever look at.
const LIMITER_AFTER = `/**
 * @license
 */
export declare const JOB_LIMITER: import("@workglow/util").ServiceToken<ILimiter>;
/** An opaque slot reservation. */
export type LimiterToken = NonNullable<unknown>;
export type LimiterScope = "process" | "cluster";
/**
 * Interface for a job limiter.
 */
export interface ILimiter {
    readonly scope: LimiterScope;
    /** Atomic check-and-record. */
    tryAcquire(): Promise<LimiterToken | null>;
    release(token: unknown): Promise<void>;
}
`;

const TABULAR_BEFORE = `export interface ITabularStorage<Schema, PrimaryKeyNames extends ReadonlyArray<keyof Schema>> {
    put(value: InsertType): Promise<Entity>;
    putBulk(values: InsertType[]): Promise<Entity[]>;
}
`;

// The 0.6.8 addition: a new REQUIRED member, which every downstream
// `implements ITabularStorage` then lacks.
const TABULAR_AFTER = `export interface UniqueKeyPutResult<Entity> {
    readonly entity: Entity;
    readonly inserted: boolean;
}
export interface ITabularStorage<Schema, PrimaryKeyNames extends ReadonlyArray<keyof Schema>> {
    put(value: InsertType): Promise<Entity>;
    putByUniqueKey(value: InsertType, uniqueKey: ReadonlyArray<keyof Entity>): Promise<UniqueKeyPutResult<Entity>>;
    putBulk(values: InsertType[]): Promise<Entity[]>;
}
`;

/** Every fixture file doubles as an entry point unless `entries` names them. */
const surfaceOf = (
  files: Record<string, string>,
  entries: readonly string[] = Object.keys(files)
): PackageSurface => buildPublicSurface(new Map(Object.entries(files)), entries);

const diff = (
  before: Record<string, string>,
  after: Record<string, string>,
  entries?: readonly string[],
  guarded: ReadonlySet<string> = new Set()
): SurfaceChange[] => diffSurfaces(surfaceOf(before, entries), surfaceOf(after, entries), guarded);

const summary = (changes: readonly SurfaceChange[]): string[] =>
  changes.map((c) => `${c.kind} ${c.key}`);

/** Every declaration key one file declares, in order. */
const keysOf = (text: string): string[] => {
  const mod = parseModule(text);
  return [...[...mod.declarations.values()].flat(), ...mod.ambient].map((b) => b.key);
};

const verdictFor = (
  changes: readonly SurfaceChange[],
  over: { previousVersion?: string; nextVersion?: string; changelogEntry?: string } = {}
): ReturnType<typeof evaluateSurfaceBump> =>
  evaluateSurfaceBump({
    name: "@workglow/example",
    previousVersion: over.previousVersion ?? "0.6.7",
    nextVersion: over.nextVersion ?? "0.6.8",
    changes,
    changelogEntry: over.changelogEntry ?? "## 0.6.8\n\n### Features\n\n- something",
  });

describe("normalizeDeclarations", () => {
  it("erases comments and layout but keeps string literals verbatim", () => {
    const a = normalizeDeclarations(`export type A = "a // b" | 'c /* d */';\n// trailing`);
    expect(a).toBe(`export type A="a // b"|'c /* d */';`);
  });

  it("keeps a space only between two word characters", () => {
    expect(normalizeDeclarations("export   interface  X   extends Y { a : 1 }")).toBe(
      "export interface X extends Y{a:1}"
    );
  });

  it("drops a trailing comma before a closing bracket", () => {
    expect(normalizeDeclarations("export { a, b, } from './x';")).toBe(
      normalizeDeclarations("export {a,b} from './x';")
    );
  });

  it("does not end a template literal type at a brace inside its hole", () => {
    const text = 'export type T = `${Foo<{ a: "}" }>}-x`;\nexport type U = 1;';
    expect(keysOf(text)).toEqual(["type T", "type U"]);
  });
});

describe("parseModule", () => {
  it("keys each top-level declaration by kind and name", () => {
    expect(keysOf(LIMITER_AFTER)).toEqual([
      "const JOB_LIMITER",
      "type LimiterToken",
      "type LimiterScope",
      "interface ILimiter",
    ]);
  });

  it("ends a class at its body even when a heritage clause holds braces", () => {
    const text = `export declare class A extends B<{ x: 1 }> {\n  m(): void;\n}\nexport declare function f(): void;`;
    expect(keysOf(text)).toEqual(["class A", "function f"]);
  });

  it("reads re-export lists name by name, with renames and type-only marks", () => {
    const mod = parseModule(
      `export { a, b as c } from "./x";\nexport type { T } from "./t";\nexport * from "./y";\nexport * as ns from "./z";`
    );
    expect(mod.named).toEqual([
      { exported: "a", original: "a", from: "./x", typeOnly: false },
      { exported: "c", original: "b", from: "./x", typeOnly: false },
      { exported: "T", original: "T", from: "./t", typeOnly: true },
    ]);
    expect(mod.stars).toEqual([
      { from: "./y", as: undefined },
      { from: "./z", as: "ns" },
    ]);
  });

  it("records imports but declares nothing for them", () => {
    const mod = parseModule(`import type { X as Y } from "./x";\nexport type Z = Y;`);
    expect(mod.imports.get("Y")).toEqual({ from: "./x", original: "X" });
    expect(keysOf(`import type { X } from "./x";\nexport type Y = X;`)).toEqual(["type Y"]);
  });

  it("declares each name of a multi-declarator const on its own", () => {
    const mod = parseModule(
      "export declare const a: () => void, b: <T>(x: Map<string, T>) => T, c: { x: 1, y: 2 };"
    );
    expect(keysOf("export declare const a: 1, b: 2;")).toEqual(["const a", "const b"]);
    expect([...mod.exported]).toEqual(["a", "b", "c"]);
    expect(mod.declarations.get("b")![0]!.text).toBe(
      "export declare const b:<T>(x:Map<string,T>)=>T;"
    );
  });

  it("drops untyped private members from a class but keeps a private constructor", () => {
    const [block] = parseModule(
      `export declare class A {\n  private cache;\n  private static readonly x;\n  #private;\n  private constructor();\n  m(): void;\n}`
    ).declarations.get("A")!;
    expect(block!.text).toBe("export declare class A{private constructor();m():void;}");
  });

  it("keys module augmentations and globals as ambient", () => {
    const mod = parseModule(
      `declare module "x" {\n  interface A {}\n}\ndeclare global {\n  var y: 1;\n}`
    );
    expect(mod.ambient.map((b) => b.key)).toEqual([`module "x"`, "global"]);
  });
});

describe("diffSurfaces", () => {
  it("reports the tryAcquire narrowing as a changed interface", () => {
    const changes = diff(
      { "dist/ILimiter.d.ts": LIMITER_BEFORE },
      { "dist/ILimiter.d.ts": LIMITER_AFTER }
    );
    expect(summary(changes)).toEqual([
      "added export LimiterToken",
      "changed interface ILimiter",
      "added type LimiterToken",
    ]);
  });

  it("reports the putByUniqueKey member as a changed interface, not an addition", () => {
    const changes = diff({ "dist/T.d.ts": TABULAR_BEFORE }, { "dist/T.d.ts": TABULAR_AFTER });
    expect(summary(changes)).toEqual([
      "added export UniqueKeyPutResult",
      "changed interface ITabularStorage",
      "added interface UniqueKeyPutResult",
    ]);
  });

  it("sees nothing in a comment-only or reformat-only edit", () => {
    const reworded = LIMITER_BEFORE.replace("Interface for a job limiter.", "A job limiter.")
      .replace("/** Atomic check-and-record. */", "// reserves a slot")
      .replace("    readonly scope: LimiterScope;", "  readonly   scope:LimiterScope ;");
    expect(diff({ "dist/L.d.ts": LIMITER_BEFORE }, { "dist/L.d.ts": reworded })).toEqual([]);
  });

  it("does not count a declaration moved to another file, word for word", () => {
    expect(
      diff(
        {
          "dist/index.d.ts": `export * from "./a";`,
          "dist/a.d.ts": "export type A = 1;\nexport type B = 2;",
        },
        {
          "dist/index.d.ts": `export * from "./a";\nexport * from "./b";`,
          "dist/a.d.ts": "export type A = 1;",
          "dist/b.d.ts": "export type B = 2;",
        },
        ["dist/index.d.ts"]
      )
    ).toEqual([]);
  });

  it("reports a removed declaration, and the name it was exported under", () => {
    const changes = diff(
      { "dist/a.d.ts": "export type A = 1;\nexport type B = 2;" },
      { "dist/a.d.ts": "export type A = 1;" }
    );
    expect(changes).toEqual([
      { kind: "removed", key: "export B", files: ["dist/a.d.ts"], before: "type B" },
      { kind: "removed", key: "type B", files: ["dist/a.d.ts"], before: "export type B=2;" },
    ]);
  });
});

describe("public surface", () => {
  // Shaped like a provider package: one entry, a barrel, and modules under it.
  const ENTRY = ["dist/ai.d.ts"];
  const provider = (common: Record<string, string>): Record<string, string> => ({
    "dist/ai.d.ts": `export * from "./ai/index";`,
    "dist/ai/index.d.ts": `export * from "./common/Public";\nexport { a } from "./common/Listed.js";`,
    ...common,
  });

  it("ignores a module no entry point reaches", () => {
    const before = provider({
      "dist/ai/common/Public.d.ts": "export type P = 1;",
      "dist/ai/common/Listed.d.ts": "export type a = 1;",
      "dist/ai/common/Internal.d.ts":
        "export interface NeedleReasoningFilter {\n  push(delta: string): string;\n}\nexport declare function createNeedleReasoningFilter(): NeedleReasoningFilter;",
    });
    const after = {
      ...before,
      "dist/ai/common/Internal.d.ts":
        "export declare function createNeedleReasoningFilter(): NeedleTextFilter;",
    };
    expect(diff(before, after, ENTRY)).toEqual([]);
  });

  it("compares a module reached through a chain of `export *`", () => {
    const before = provider({
      "dist/ai/common/Public.d.ts": "export interface IP {\n  run(): Promise<unknown>;\n}",
      "dist/ai/common/Listed.d.ts": "export type a = 1;",
    });
    const after = {
      ...before,
      "dist/ai/common/Public.d.ts": "export interface IP {\n  run(): Promise<string>;\n}",
    };
    const changes = diff(before, after, ENTRY);
    expect(summary(changes)).toEqual(["changed interface IP"]);
    expect(verdictFor(changes).ok).toBe(false);
  });

  it("makes only the names a re-export list names reachable", () => {
    const before = provider({
      "dist/ai/common/Public.d.ts": "export type P = 1;",
      "dist/ai/common/Listed.d.ts": "export type a = 1;\nexport interface IUnlisted {\n  x: 1;\n}",
    });
    const after = {
      ...before,
      "dist/ai/common/Listed.d.ts": "export type a = 1;\nexport interface IUnlisted {\n  x: 2;\n}",
    };
    expect(diff(before, after, ENTRY)).toEqual([]);
    const listedChanged = { ...before, "dist/ai/common/Listed.d.ts": "export type a = 2;" };
    expect(summary(diff(before, listedChanged, ENTRY))).toEqual(["changed type a"]);
  });

  it("reports a renamed re-export as the old name removed", () => {
    const before = {
      "dist/i.d.ts": `export { a as b } from "./m";`,
      "dist/m.d.ts": "export type a = 1;",
    };
    const after = { ...before, "dist/i.d.ts": `export { a as c } from "./m";` };
    expect(summary(diff(before, after, ["dist/i.d.ts"]))).toEqual([
      "removed export b",
      "added export c",
    ]);
  });

  // The HFT_ToolMarkup case: the function moved to `@workglow/ai/provider-utils`
  // and the module re-exports it under the same name.
  const MARKUP_BEFORE = {
    "dist/ai.d.ts": `export * from "./ai/runtime";`,
    "dist/ai/runtime.d.ts": `export * from "./common/HFT_ToolMarkup";`,
    "dist/ai/common/HFT_ToolMarkup.d.ts":
      "export declare function createToolCallMarkupFilter(emit: (text: string) => void): {\n    feed: (token: string) => void;\n    flush: () => void;\n};",
  };
  const MARKUP_AFTER = {
    ...MARKUP_BEFORE,
    "dist/ai/common/HFT_ToolMarkup.d.ts": `export { createToolCallMarkupFilter } from "@workglow/ai/provider-utils";\nexport type { IToolCallMarkupFilter } from "@workglow/ai/provider-utils";`,
  };

  it("passes a declaration replaced by a re-export from a package in the same run", () => {
    const changes = diff(MARKUP_BEFORE, MARKUP_AFTER, ["dist/ai.d.ts"], new Set(["@workglow/ai"]));
    expect(summary(changes)).toEqual([
      "added export IToolCallMarkupFilter",
      "moved export createToolCallMarkupFilter",
      "moved function createToolCallMarkupFilter",
    ]);
    expect(changes.find((c) => c.kind === "moved")).toMatchObject({
      name: "createToolCallMarkupFilter",
      to: "@workglow/ai/provider-utils",
    });
    expect(verdictFor(changes)).toEqual({ ok: true, why: "additive" });
  });

  it("does not treat a re-export from a package outside the run as a move", () => {
    const changes = diff(
      MARKUP_BEFORE,
      MARKUP_AFTER,
      ["dist/ai.d.ts"],
      new Set(["@workglow/util"])
    );
    expect(verdictFor(changes).ok).toBe(false);
  });

  it("refuses a name that disappears entirely", () => {
    const gone = { ...MARKUP_BEFORE, "dist/ai/common/HFT_ToolMarkup.d.ts": "export {};" };
    const changes = diff(MARKUP_BEFORE, gone, ["dist/ai.d.ts"], new Set(["@workglow/ai"]));
    expect(summary(changes)).toEqual([
      "removed export createToolCallMarkupFilter",
      "removed function createToolCallMarkupFilter",
    ]);
    expect(verdictFor(changes).ok).toBe(false);
  });
});

describe("resolveModule", () => {
  const files = new Map<string, string>([
    ["dist/ai.d.ts", ""],
    ["dist/ai/index.d.ts", ""],
    ["dist/tabular/Cursor.d.ts", ""],
  ]);

  it("resolves the specifier spellings declaration emit uses", () => {
    expect(resolveModule(files, "dist/common.d.ts", "./tabular/Cursor")).toBe(
      "dist/tabular/Cursor.d.ts"
    );
    expect(resolveModule(files, "dist/common.d.ts", "./tabular/Cursor.js")).toBe(
      "dist/tabular/Cursor.d.ts"
    );
    expect(resolveModule(files, "dist/x/y.d.ts", "../ai/index")).toBe("dist/ai/index.d.ts");
    expect(resolveModule(files, "dist/ai.d.ts", "./ai")).toBe("dist/ai.d.ts");
    expect(resolveModule(files, "dist/other/z.d.ts", "../ai/")).toBe("dist/ai/index.d.ts");
    expect(resolveModule(files, "dist/ai.d.ts", "@workglow/ai")).toBeUndefined();
  });
});

describe("typeEntryPoints", () => {
  const files = new Map<string, string>([
    ["dist/ai.d.ts", ""],
    ["dist/ai.browser.d.ts", ""],
    ["dist/ai-runtime.d.ts", ""],
    ["dist/tools/a.d.ts", ""],
    ["dist/tools/b.d.ts", ""],
    ["dist/internal.d.ts", ""],
  ]);

  it("collects every types target, nested conditions included, and .d.ts beside a runtime target", () => {
    const manifest = {
      exports: {
        "./ai": {
          browser: { types: "./dist/ai.browser.d.ts", import: "./dist/ai.browser.js" },
          types: "./dist/ai.d.ts",
          import: "./dist/ai.js",
        },
        "./ai-runtime": { import: "./dist/ai-runtime.js" },
        "./tools/*": { types: "./dist/tools/*.d.ts" },
        "./package.json": "./package.json",
      },
    };
    expect(typeEntryPoints(manifest, files)).toEqual([
      "dist/ai-runtime.d.ts",
      "dist/ai.browser.d.ts",
      "dist/ai.d.ts",
      "dist/tools/a.d.ts",
      "dist/tools/b.d.ts",
    ]);
  });

  it("falls back to types, then main, without an exports map", () => {
    expect(typeEntryPoints({ types: "./dist/ai.d.ts" }, files)).toEqual(["dist/ai.d.ts"]);
    expect(typeEntryPoints({ main: "./dist/internal.js" }, files)).toEqual(["dist/internal.d.ts"]);
  });
});

describe("evaluateSurfaceBump", () => {
  const tryAcquire = diff({ "dist/L.d.ts": LIMITER_BEFORE }, { "dist/L.d.ts": LIMITER_AFTER });
  const putByUniqueKey = diff({ "dist/T.d.ts": TABULAR_BEFORE }, { "dist/T.d.ts": TABULAR_AFTER });

  it("refuses the tryAcquire narrowing in a patch", () => {
    const verdict = verdictFor(tryAcquire, { previousVersion: "0.5.0", nextVersion: "0.5.1" });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.changes.map((c) => c.key)).toEqual([
      "interface ILimiter",
    ]);
  });

  it("refuses the putByUniqueKey addition in a patch", () => {
    const verdict = verdictFor(putByUniqueKey);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.changes.map((c) => c.key)).toEqual([
      "interface ITabularStorage",
    ]);
  });

  it("passes a comment-only change", () => {
    const reworded = diff(
      { "dist/L.d.ts": LIMITER_BEFORE },
      { "dist/L.d.ts": LIMITER_BEFORE.replace("Interface for a job limiter.", "Reworded.") }
    );
    expect(verdictFor(reworded)).toEqual({ ok: true, why: "unchanged" });
  });

  it("passes a new top-level export in a patch", () => {
    const added = diff(
      { "dist/index.d.ts": `export * from "./a";`, "dist/a.d.ts": "export type A = 1;" },
      {
        "dist/index.d.ts": `export * from "./a";\nexport * from "./b";`,
        "dist/a.d.ts": "export type A = 1;",
        "dist/b.d.ts": "export declare function b(): void;\nexport interface IB {\n  x: 1;\n}",
      }
    );
    expect(added.every((c) => c.kind === "added")).toBe(true);
    expect(verdictFor(added)).toEqual({ ok: true, why: "additive" });
  });

  it("lifts the refusal when the changelog entry declares Breaking Changes", () => {
    const entry =
      "## 0.6.8\n\n### Breaking Changes\n\n- **features(storage)**: putByUniqueKey\n\n### Features\n";
    expect(verdictFor(putByUniqueKey, { changelogEntry: entry })).toEqual({
      ok: true,
      why: "declared-breaking",
    });
  });

  it("passes a minor bump on a 0.x line", () => {
    expect(verdictFor(putByUniqueKey, { nextVersion: "0.7.0" })).toEqual({
      ok: true,
      why: "break-slot",
    });
  });

  it("passes a package with nothing published below it", () => {
    expect(
      evaluateSurfaceBump({
        name: "@workglow/new",
        previousVersion: undefined,
        nextVersion: "0.6.10",
        changes: [],
        changelogEntry: undefined,
      })
    ).toEqual({ ok: true, why: "unpublished" });
  });
});

describe("isBelowBreakSlot", () => {
  it("treats the minor as the break slot on 0.x", () => {
    expect(isBelowBreakSlot("0.6.8", "0.6.9")).toBe(true);
    expect(isBelowBreakSlot("0.6.9", "0.7.0")).toBe(false);
    expect(isBelowBreakSlot("0.6.9", "1.0.0")).toBe(false);
  });

  it("treats the major as the break slot from 1.0", () => {
    expect(isBelowBreakSlot("1.2.3", "1.3.0")).toBe(true);
    expect(isBelowBreakSlot("1.2.3", "2.0.0")).toBe(false);
  });

  it("treats any bump off 0.0.x as a break slot, since ^0.0.3 admits nothing else", () => {
    expect(isBelowBreakSlot("0.0.3", "0.0.4")).toBe(false);
  });
});

describe("previousPublishedVersion", () => {
  it("picks the highest stable version below the one being cut", () => {
    expect(previousPublishedVersion(["0.6.7", "0.6.9", "0.6.8", "0.7.0-beta.1"], "0.6.10")).toBe(
      "0.6.9"
    );
  });

  it("skips a version that was tagged but never published", () => {
    expect(previousPublishedVersion(["0.6.8", "0.6.9"], "0.6.11")).toBe("0.6.9");
  });

  it("returns undefined when nothing is below", () => {
    expect(previousPublishedVersion([], "0.1.0")).toBeUndefined();
  });
});

describe("changelog", () => {
  const changelog =
    "# @workglow/storage\n\n## 0.7.0\n\n### Breaking Changes\n\n- x\n\n## 0.6.9\n\n### Performance\n\n- y\n";

  it("reads one version's section and nothing after it", () => {
    expect(readChangelogEntry(changelog, "0.6.9")).toBe("## 0.6.9\n\n### Performance\n\n- y\n");
    expect(declaresBreakingChanges(readChangelogEntry(changelog, "0.7.0"))).toBe(true);
    expect(declaresBreakingChanges(readChangelogEntry(changelog, "0.6.9"))).toBe(false);
    expect(readChangelogEntry(changelog, "0.5.0")).toBeUndefined();
  });

  it("does not read a mention of breaking changes in prose as the heading", () => {
    expect(declaresBreakingChanges("## 0.6.9\n\n- no Breaking Changes here\n")).toBe(false);
  });
});

describe("parseBunsetDryRun", () => {
  const output = `lockstep: versioning private packages too, so none falls out of the shared version.
--- Dry Run ---

@workglow/a2ui: 0.6.9 → 0.6.10 (patch)

Changelog entry for @workglow/a2ui:
## 0.6.10

### Features

- a thing

@workglow/storage: 0.6.9 → 0.7.0 (minor)

Changelog entry for @workglow/storage:
## 0.7.0

### Breaking Changes

- **features(storage)**: putByUniqueKey

(workspace root): 0.6.9 → 0.6.10
Would commit: chore: release 0.6.10 for 2 packages

@workglow/fake: 1.0.0 → 9.9.9 (major)
`;

  it("reads each package's next version and changelog entry, stopping at the commit preview", () => {
    const plan = parseBunsetDryRun(output);
    expect(plan.map((p) => [p.name, p.nextVersion])).toEqual([
      ["@workglow/a2ui", "0.6.10"],
      ["@workglow/storage", "0.7.0"],
    ]);
    expect(plan[0]!.changelogEntry).toBe("## 0.6.10\n\n### Features\n\n- a thing");
    expect(declaresBreakingChanges(plan[1]!.changelogEntry)).toBe(true);
  });
});

describe("formatSurfaceRefusal", () => {
  it("names the package, the file and the members that crossed the surface", () => {
    const verdict = verdictFor(
      diff(
        { "dist/limiter/ILimiter.d.ts": LIMITER_BEFORE },
        { "dist/limiter/ILimiter.d.ts": LIMITER_AFTER }
      ),
      { previousVersion: "0.5.0", nextVersion: "0.5.1" }
    );
    if (verdict.ok) throw new Error("expected a refusal");
    expect(formatSurfaceRefusal([verdict])).toBe(
      [
        "  @workglow/example 0.5.0 → 0.5.1",
        "    changed interface ILimiter  (dist/limiter/ILimiter.d.ts)",
        "      - tryAcquire():Promise<unknown|null>;",
        "      + tryAcquire():Promise<LimiterToken|null>;",
      ].join("\n")
    );
  });

  it("shows an added member alone", () => {
    const change = diff({ "dist/T.d.ts": TABULAR_BEFORE }, { "dist/T.d.ts": TABULAR_AFTER }).find(
      (c) => c.key === "interface ITabularStorage"
    );
    if (change?.kind !== "changed") throw new Error("expected a changed interface");
    expect(excerptChange(change.before, change.after)).toEqual({
      removed: [],
      added: [
        "putByUniqueKey(value:InsertType, uniqueKey:ReadonlyArray<keyof Entity>):Promise<UniqueKeyPutResult<Entity>>;",
      ],
    });
  });
});
