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
  runResolver,
  typeEntryPoints,
  type EntryPoint,
  type ExternalResolver,
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

/**
 * Every fixture file doubles as an entry point unless `entries` names them. A
 * plain path is an entry labelled by that path; an {@link EntryPoint} is used as is.
 */
const surfaceOf = (
  files: Record<string, string>,
  entries: readonly (string | EntryPoint)[] = Object.keys(files)
): PackageSurface =>
  buildPublicSurface(
    new Map(Object.entries(files)),
    entries.map((e) => (typeof e === "string" ? { label: e, subpath: `./${e}`, file: e } : e))
  );

const diff = (
  before: Record<string, string>,
  after: Record<string, string>,
  entries?: readonly (string | EntryPoint)[],
  resolveExternal?: ExternalResolver
): SurfaceChange[] =>
  diffSurfaces(surfaceOf(before, entries), surfaceOf(after, entries), resolveExternal);

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

  it("collapses untyped private members into one marker but keeps a private constructor", () => {
    const [block] = parseModule(
      `export declare class A {\n  private cache;\n  private static readonly x;\n  #private;\n  private constructor();\n  m(): void;\n}`
    ).declarations.get("A")!;
    expect(block!.text).toBe("export declare class A{private;private constructor();m():void;}");
  });

  it("files an `export default` declaration under `default` and its own name", () => {
    for (const [text, key] of [
      ["export default class Foo {\n  m(): void;\n}", "class Foo"],
      ["export default function foo(): void;", "function foo"],
      ["export default interface IFoo {\n  x: 1;\n}", "interface IFoo"],
      ["export default abstract class {\n  m(): void;\n}", "class default"],
    ] as const) {
      const mod = parseModule(text);
      expect(mod.declarations.get("default")!.map((b) => b.key)).toEqual([key]);
      expect(mod.exported.has("default")).toBe(true);
    }
    expect(parseModule("export default class Foo {\n}").declarations.get("Foo")).toBeDefined();
    expect(parseModule("declare class Foo {\n}\nexport default Foo;").named).toEqual([
      { exported: "default", original: "Foo", from: undefined, typeOnly: false },
    ]);
  });

  it("records default, namespace, mixed and type-only imports", () => {
    const mod = parseModule(
      [
        `import Foo from "./foo";`,
        `import * as Ns from "./ns";`,
        `import Bar, { a, b as c } from "./bar";`,
        `import Baz, * as All from "./baz";`,
        `import type Qux from "./qux";`,
        `import type * as TNs from "./tns";`,
        `import type { T } from "./t";`,
        `import "./side";`,
      ].join("\n")
    );
    expect(Object.fromEntries(mod.imports)).toEqual({
      Foo: { from: "./foo", original: "default" },
      Ns: { from: "./ns", original: "*" },
      Bar: { from: "./bar", original: "default" },
      a: { from: "./bar", original: "a" },
      c: { from: "./bar", original: "b" },
      Baz: { from: "./baz", original: "default" },
      All: { from: "./baz", original: "*" },
      Qux: { from: "./qux", original: "default" },
      TNs: { from: "./tns", original: "*" },
      T: { from: "./t", original: "T" },
    });
    expect(mod.sideEffects).toEqual(["./side"]);
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
      "added export dist/ILimiter.d.ts:LimiterToken",
      "changed interface ILimiter",
      "added type LimiterToken",
    ]);
  });

  it("reports the putByUniqueKey member as a changed interface, not an addition", () => {
    const changes = diff({ "dist/T.d.ts": TABULAR_BEFORE }, { "dist/T.d.ts": TABULAR_AFTER });
    expect(summary(changes)).toEqual([
      "added export dist/T.d.ts:UniqueKeyPutResult",
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
      { kind: "removed", key: "export dist/a.d.ts:B", files: ["dist/a.d.ts"], before: "type B" },
      { kind: "removed", key: "type B", files: ["dist/a.d.ts"], before: "export type B=2;" },
    ]);
  });

  it("refuses two overloads swapped, since TypeScript tries them in order", () => {
    const one = "export declare function f(x: string): string;";
    const two = "export declare function f(x: number): number;";
    const changes = diff({ "dist/f.d.ts": `${one}\n${two}` }, { "dist/f.d.ts": `${two}\n${one}` });
    expect(summary(changes)).toEqual(["changed function f"]);
    expect(verdictFor(changes).ok).toBe(false);
  });

  it("does not count one of two same-named declarations moving to another file", () => {
    const options = (field: string): string => `export interface Options {\n  ${field}: 1;\n}`;
    const barrel = (b: string): string =>
      `export { Options as AOptions } from "./a";\nexport { Options as BOptions } from "./${b}";`;
    expect(
      diff(
        { "dist/i.d.ts": barrel("b"), "dist/a.d.ts": options("x"), "dist/b.d.ts": options("y") },
        { "dist/i.d.ts": barrel("c"), "dist/a.d.ts": options("x"), "dist/c.d.ts": options("y") },
        ["dist/i.d.ts"]
      )
    ).toEqual([]);
  });

  it("changes a class that gains its first private member, not one that gains another", () => {
    const cls = (body: string): Record<string, string> => ({
      "dist/c.d.ts": `export declare class C {\n${body}\n  m(): void;\n}`,
    });
    const first = diff(cls(""), cls("  private a;"));
    expect(summary(first)).toEqual(["changed class C"]);
    expect(verdictFor(first).ok).toBe(false);
    expect(diff(cls("  private a;"), cls("  private a;\n  private b;\n  #private;"))).toEqual([]);
    expect(summary(diff(cls("  #private;"), cls("")))).toEqual(["changed class C"]);
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
      "removed export dist/i.d.ts:b",
      "added export dist/i.d.ts:c",
    ]);
  });

  it("reaches an `export default` declaration re-exported as default or by name", () => {
    for (const reexport of [
      `export { default } from "./m";`,
      `export { default as Foo } from "./m";`,
    ]) {
      const before = {
        "dist/i.d.ts": reexport,
        "dist/m.d.ts": "export default class Foo {\n  run(): void;\n}",
      };
      const after = { ...before, "dist/m.d.ts": "export default class Foo {\n  run(): string;\n}" };
      const changes = diff(before, after, ["dist/i.d.ts"]);
      expect(summary(changes)).toEqual(["changed class Foo"]);
      expect(verdictFor(changes).ok).toBe(false);
    }
    const aliased = {
      "dist/i.d.ts": `export { default } from "./m";`,
      "dist/m.d.ts": "declare function foo(): void;\nexport default foo;",
    };
    const retyped = {
      ...aliased,
      "dist/m.d.ts": "declare function foo(): string;\nexport default foo;",
    };
    expect(summary(diff(aliased, retyped, ["dist/i.d.ts"]))).toEqual(["changed function foo"]);
  });

  it("reaches what a default or namespace import is re-exported as", () => {
    const viaDefault = {
      "dist/i.d.ts": `import Foo from "./m";\nexport { Foo };`,
      "dist/m.d.ts": "export default interface IFoo {\n  x: 1;\n}",
    };
    expect(
      summary(
        diff(
          viaDefault,
          { ...viaDefault, "dist/m.d.ts": "export default interface IFoo {\n  x: 2;\n}" },
          ["dist/i.d.ts"]
        )
      )
    ).toEqual(["changed interface IFoo"]);

    const viaNamespace = {
      "dist/i.d.ts": `import type * as Ns from "./m";\nexport { Ns };`,
      "dist/m.d.ts": "export interface IM {\n  x: 1;\n}",
    };
    const changes = diff(
      viaNamespace,
      { ...viaNamespace, "dist/m.d.ts": "export interface IM {\n  x: 2;\n}" },
      ["dist/i.d.ts"]
    );
    expect(summary(changes)).toEqual(["changed interface IM"]);
    expect(verdictFor(changes).ok).toBe(false);
  });

  it("follows side-effect imports for ambient declarations only", () => {
    const before = {
      "dist/i.d.ts": `import "./augment";\nexport type A = 1;`,
      "dist/augment.d.ts": `import "./deeper";\ndeclare global {\n  interface Window {\n    x: 1;\n  }\n}\nexport type Hidden = 1;`,
      "dist/deeper.d.ts": `declare module "y" {\n  interface Y {\n    y: 1;\n  }\n}`,
    };
    const entries = ["dist/i.d.ts"];
    expect(
      diff(
        before,
        {
          ...before,
          "dist/augment.d.ts": before["dist/augment.d.ts"].replace("Hidden = 1", "Hidden = 2"),
        },
        entries
      )
    ).toEqual([]);
    const global = diff(
      before,
      { ...before, "dist/augment.d.ts": before["dist/augment.d.ts"].replace("x: 1", "x: 2") },
      entries
    );
    expect(summary(global)).toEqual(["changed global"]);
    const deeper = diff(
      before,
      { ...before, "dist/deeper.d.ts": before["dist/deeper.d.ts"].replace("y: 1", "y: 2") },
      entries
    );
    expect(summary(deeper)).toEqual([`changed module "y"`]);
  });

  it("refuses a name dropped from one entry while another still exports it", () => {
    const entries: EntryPoint[] = [
      { label: ".[browser.types]", subpath: ".", file: "dist/browser.d.ts" },
      { label: ".[types]", subpath: ".", file: "dist/node.d.ts" },
    ];
    const before = {
      "dist/browser.d.ts": `export * from "./common";`,
      "dist/node.d.ts": `export * from "./common";`,
      "dist/common.d.ts": "export type Foo = 1;\nexport type Bar = 2;",
    };
    const after = { ...before, "dist/browser.d.ts": `export { Bar } from "./common";` };
    const changes = diff(before, after, entries);
    expect(summary(changes)).toEqual(["removed export .[browser.types]:Foo"]);
    expect(verdictFor(changes).ok).toBe(false);
  });
});

describe("moves to another package", () => {
  // The HFT_ToolMarkup case: the function moved to `@workglow/ai/provider-utils`
  // and the module re-exports it under the same name, from both entries.
  const HFT_ENTRIES: EntryPoint[] = [
    { label: "./ai-runtime[types]", subpath: "./ai-runtime", file: "dist/ai-runtime.d.ts" },
    { label: "./ai[types]", subpath: "./ai", file: "dist/ai.d.ts" },
  ];
  const FILTER =
    "export declare function createToolCallMarkupFilter(emit: (text: string) => void): {\n    feed: (token: string) => void;\n    flush: () => void;\n};";
  const MARKUP_BEFORE = {
    "dist/ai.d.ts": `export * from "./ai/runtime";`,
    "dist/ai-runtime.d.ts": `export * from "./ai/runtime";`,
    "dist/ai/runtime.d.ts": `export * from "./common/HFT_ToolMarkup";`,
    "dist/ai/common/HFT_ToolMarkup.d.ts": FILTER,
  };
  const MARKUP_AFTER = {
    ...MARKUP_BEFORE,
    "dist/ai/common/HFT_ToolMarkup.d.ts": `export { createToolCallMarkupFilter } from "@workglow/ai/provider-utils";\nexport type { IToolCallMarkupFilter } from "@workglow/ai/provider-utils";`,
  };
  /** `@workglow/ai` as this run built it, with the filter declared as `filter`. */
  const aiRun = (filter: string): ExternalResolver =>
    runResolver(
      new Map([
        [
          "@workglow/ai",
          surfaceOf(
            {
              "dist/provider-utils.d.ts": `export * from "./markup";`,
              "dist/markup.d.ts": `${filter}\nexport interface IToolCallMarkupFilter {\n  feed(token: string): void;\n}`,
            },
            [
              {
                label: "./provider-utils[types]",
                subpath: "./provider-utils",
                file: "dist/provider-utils.d.ts",
              },
            ]
          ),
        ],
      ])
    );

  it("passes a declaration re-exported, unchanged, from a package in the same run", () => {
    const changes = diff(MARKUP_BEFORE, MARKUP_AFTER, HFT_ENTRIES, aiRun(FILTER));
    expect(summary(changes)).toEqual([
      "added export ./ai-runtime[types]:IToolCallMarkupFilter",
      "moved export ./ai-runtime[types]:createToolCallMarkupFilter",
      "added export ./ai[types]:IToolCallMarkupFilter",
      "moved export ./ai[types]:createToolCallMarkupFilter",
      "moved function createToolCallMarkupFilter",
    ]);
    expect(changes.find((c) => c.kind === "moved")).toMatchObject({
      name: "createToolCallMarkupFilter",
      to: "@workglow/ai/provider-utils",
    });
    expect(verdictFor(changes)).toEqual({ ok: true, why: "additive" });
  });

  it("refuses a move whose new declaration reads differently, showing old and new", () => {
    const narrowed = FILTER.replace("(text: string) => void", "(text: string) => boolean");
    const changes = diff(MARKUP_BEFORE, MARKUP_AFTER, HFT_ENTRIES, aiRun(narrowed));
    expect(summary(changes).filter((c) => !c.startsWith("added"))).toEqual([
      "changed export ./ai-runtime[types]:createToolCallMarkupFilter",
      "changed export ./ai[types]:createToolCallMarkupFilter",
      "changed function createToolCallMarkupFilter",
    ]);
    const change = changes.find((c) => c.key === "function createToolCallMarkupFilter");
    expect(change).toMatchObject({
      before: expect.stringContaining("emit:(text:string)=>void"),
      after: expect.stringContaining("emit:(text:string)=>boolean"),
    });
    expect(verdictFor(changes).ok).toBe(false);
  });

  it("refuses a re-export from a package that is not in the run", () => {
    const changes = diff(MARKUP_BEFORE, MARKUP_AFTER, HFT_ENTRIES, runResolver(new Map()));
    expect(summary(changes)).toContain("removed function createToolCallMarkupFilter");
    expect(verdictFor(changes).ok).toBe(false);
  });

  it("refuses a name that disappears entirely", () => {
    const gone = { ...MARKUP_BEFORE, "dist/ai/common/HFT_ToolMarkup.d.ts": "export {};" };
    const changes = diff(MARKUP_BEFORE, gone, HFT_ENTRIES, aiRun(FILTER));
    expect(summary(changes)).toEqual([
      "removed export ./ai-runtime[types]:createToolCallMarkupFilter",
      "removed export ./ai[types]:createToolCallMarkupFilter",
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

  it("labels each entry by subpath and condition path, `types` first at each level", () => {
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
      { label: "./ai-runtime[import]", subpath: "./ai-runtime", file: "dist/ai-runtime.d.ts" },
      { label: "./ai[browser.types]", subpath: "./ai", file: "dist/ai.browser.d.ts" },
      { label: "./ai[types]", subpath: "./ai", file: "dist/ai.d.ts" },
      { label: "./tools/a[types]", subpath: "./tools/a", file: "dist/tools/a.d.ts" },
      { label: "./tools/b[types]", subpath: "./tools/b", file: "dist/tools/b.d.ts" },
    ]);
  });

  it("reads every `*` in a pattern as the same text", () => {
    const nested = new Map<string, string>([
      ["dist/a/a.d.ts", ""],
      ["dist/a/b.d.ts", ""],
    ]);
    expect(typeEntryPoints({ exports: { "./*": { types: "./dist/*/*.d.ts" } } }, nested)).toEqual([
      { label: "./a[types]", subpath: "./a", file: "dist/a/a.d.ts" },
    ]);
  });

  it("treats a conditions-only exports map as the `.` subpath", () => {
    expect(
      typeEntryPoints({ exports: { types: "./dist/ai.d.ts", import: "./dist/ai.js" } }, files)
    ).toEqual([{ label: ".[types]", subpath: ".", file: "dist/ai.d.ts" }]);
  });

  it("falls back to types, then main, without an exports map", () => {
    expect(typeEntryPoints({ types: "./dist/ai.d.ts" }, files)).toEqual([
      { label: ".", subpath: ".", file: "dist/ai.d.ts" },
    ]);
    expect(typeEntryPoints({ main: "./dist/internal.js" }, files)).toEqual([
      { label: ".", subpath: ".", file: "dist/internal.d.ts" },
    ]);
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

  // A schema const carries its documentation in the type, because the value is
  // `as const`. Rewording an example in `description` changes that literal and
  // nothing a caller has to implement or pass.
  const schemaBefore = `export declare const ModelSchema: {
    readonly type: "object";
    readonly properties: {
        readonly model_name: {
            readonly type: "string";
            readonly description: "The model identifier (e.g., 'claude-opus-5', 'claude-haiku-4-5').";
        };
    };
};`;
  const schemaAfter = schemaBefore.replace("'claude-opus-5'", "'claude-opus-5-5'");

  it("passes a const schema whose only change is a description literal", () => {
    const changes = diff({ "dist/S.d.ts": schemaBefore }, { "dist/S.d.ts": schemaAfter });
    expect(summary(changes)).toEqual(["changed const ModelSchema"]);
    expect(verdictFor(changes)).toEqual({ ok: true, why: "non-breaking" });
  });

  it("still refuses a description literal change on an interface", () => {
    const before = `export interface Card {
    readonly description: "old example";
    readonly title: string;
}`;
    const after = before.replace('"old example"', '"new example"');
    const verdict = verdictFor(diff({ "dist/C.d.ts": before }, { "dist/C.d.ts": after }));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.changes.map((c) => c.key)).toEqual(["interface Card"]);
  });

  it("still refuses a string-literal union change", () => {
    const before = `export type ModelId = "claude-opus-5" | "claude-haiku-4-5";`;
    const after = before.replace('"claude-opus-5"', '"claude-opus-5-5"');
    expect(verdictFor(diff({ "dist/M.d.ts": before }, { "dist/M.d.ts": after })).ok).toBe(false);
  });

  it("still refuses a description whose type is a string union", () => {
    const before = `export declare const ModelSchema: {
    readonly description: "a" | "b";
};`;
    const after = before.replace('"a"', '"c"');
    expect(verdictFor(diff({ "dist/S.d.ts": before }, { "dist/S.d.ts": after })).ok).toBe(false);
  });

  it("still refuses a const schema that changes a description and a real field", () => {
    const after = schemaAfter.replace('readonly type: "string";', 'readonly type: "number";');
    const verdict = verdictFor(diff({ "dist/S.d.ts": schemaBefore }, { "dist/S.d.ts": after }));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.changes.map((c) => c.key)).toEqual([
      "const ModelSchema",
    ]);
  });

  const testOnlyBefore = `export declare const _testOnly: {
    readonly ANTHROPIC_RUN_FN_SPECS: {
        serves: ["text.generation"] | ["text.generation", "tool-use"];
    }[];
    readonly setClient: (client: unknown) => void;
};`;

  it("passes a _testOnly const that only gains members", () => {
    const inserted = testOnlyBefore.replace(
      "readonly setClient:",
      "readonly acceptsForced: typeof acceptsForced;\n    readonly setClient:"
    );
    const appended = testOnlyBefore.replace(
      "readonly setClient: (client: unknown) => void;",
      "readonly setClient: (client: unknown) => void;\n    readonly toSchema: typeof toSchema;"
    );
    for (const after of [inserted, appended]) {
      const changes = diff({ "dist/I.d.ts": testOnlyBefore }, { "dist/I.d.ts": after });
      expect(summary(changes)).toEqual(["changed const _testOnly"]);
      expect(verdictFor(changes)).toEqual({ ok: true, why: "non-breaking" });
    }
  });

  it("still refuses a _testOnly const that drops or retypes a member", () => {
    const dropped = testOnlyBefore.replace(
      "    readonly setClient: (client: unknown) => void;\n",
      ""
    );
    const retyped = testOnlyBefore.replace("(client: unknown) => void", "(client: string) => void");
    expect(verdictFor(diff({ "dist/I.d.ts": testOnlyBefore }, { "dist/I.d.ts": dropped })).ok).toBe(
      false
    );
    expect(verdictFor(diff({ "dist/I.d.ts": testOnlyBefore }, { "dist/I.d.ts": retyped })).ok).toBe(
      false
    );
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
