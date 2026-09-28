/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Whether a release's version number admits what changed in its published
 * `.d.ts` files.
 *
 * A green tree says nothing about this: every implementer inside the repo is
 * fixed in the same commit that changes an interface, so the break is only
 * visible to the classes downstream that `implements` it. What IS visible here
 * is the declaration text itself, before and after — so the gate compares that,
 * block by block, against the version last published.
 *
 * Everything in this module is pure; the npm and filesystem half lives in
 * `require-surface-bump.ts`.
 */

import { posix } from "node:path";

// ---------------------------------------------------------------------------
// Declaration text
// ---------------------------------------------------------------------------

const WORD_CHAR = /[\w$]/;

/**
 * Index just past the string or template literal starting at `start`.
 *
 * A template's `${…}` holes are walked with their own brace depth, so a type
 * like `` `${Foo<{ a: "}" }>}` `` does not end the literal early.
 */
export function skipQuoted(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (quote === "`" && c === "$" && text[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        const h = text[i];
        if (h === '"' || h === "'" || h === "`") {
          i = skipQuoted(text, i);
          continue;
        }
        if (h === "{") depth++;
        else if (h === "}") depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return text.length;
}

/**
 * Declaration text with comments removed and layout erased.
 *
 * Whitespace survives only where it separates two word characters
 * (`extends Foo`), and a trailing comma before a closing bracket is dropped, so
 * a JSDoc edit, a reflow or a compiler that spaces braces differently all
 * produce the same string. String and template literals are copied verbatim:
 * `"a b"` and `"ab"` are different types.
 */
export function normalizeDeclarations(text: string): string {
  let out = "";
  let pendingSpace = false;
  const emit = (s: string): void => {
    const last = out[out.length - 1];
    if (pendingSpace && last !== undefined && WORD_CHAR.test(last) && WORD_CHAR.test(s[0]!)) {
      out += " ";
    }
    out += s;
    pendingSpace = false;
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      pendingSpace = true;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      pendingSpace = true;
      continue;
    }
    if (/\s/.test(c)) {
      pendingSpace = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const end = skipQuoted(text, i);
      emit(text.slice(i, end));
      i = end;
      continue;
    }
    if ((c === "}" || c === "]" || c === ")") && out.endsWith(",")) {
      out = out.slice(0, -1);
    }
    emit(c);
    i++;
  }
  return out;
}

/** Statements whose body closes the statement: no `;` follows their `}`. */
const BLOCK_STATEMENT =
  /^(?:(?:export|declare|default|abstract) )*(?:interface|class|namespace|module|enum|const enum|global)\b/;

/**
 * Top-level statements of normalized declaration text.
 *
 * Depth counts every bracket pair, angle brackets included — the `{` in
 * `class A extends B<{ x: 1 }> {` is inside the `<`, so it does not look like
 * the class body closing. The `>` of `=>` is not a bracket.
 */
export function splitStatements(normalized: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  const push = (end: number): void => {
    const statement = normalized.slice(start, end);
    if (statement !== "" && statement !== ";") statements.push(statement);
    start = end;
  };
  while (i < normalized.length) {
    const c = normalized[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i = skipQuoted(normalized, i);
      continue;
    }
    if (c === "{" || c === "(" || c === "[" || c === "<") {
      depth++;
    } else if (c === "}" || c === ")" || c === "]" || (c === ">" && normalized[i - 1] !== "=")) {
      depth--;
      if (depth === 0 && c === "}" && BLOCK_STATEMENT.test(normalized.slice(start, i))) {
        push(i + 1);
      }
    } else if (c === ";" && depth === 0) {
      push(i + 1);
    }
    i++;
  }
  push(normalized.length);
  return statements;
}

/** `text` cut at every `separator` outside brackets and string literals. */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i = skipQuoted(text, i);
      continue;
    }
    if (c === "{" || c === "(" || c === "[" || c === "<") depth++;
    else if (c === "}" || c === ")" || c === "]" || (c === ">" && text[i - 1] !== "=")) depth--;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(text.slice(start));
  return parts.filter((p) => p !== "");
}

/** One top-level declaration: what it is called, and what it says. */
export interface DeclarationBlock {
  readonly key: string;
  readonly text: string;
}

const DECLARATION_HEAD =
  /^(?:(?:export|declare|abstract|async) )*(const enum|enum|interface|class|namespace|module|type|function|const|let|var|global)\b ?([\w$.]+|"[^"]*"|'[^']*')?/;

/**
 * Private members say nothing a consumer can reach, and declaration emit writes
 * them untyped (`private cache;`), so an internal field added in a patch would
 * otherwise read as a changed class. A private constructor has parentheses and
 * is kept: it decides whether `new` compiles.
 */
function stripPrivateMembers(classText: string): string {
  return classText
    .replace(/(?<=[{;])private(?: (?:static|readonly|override|abstract|declare))* [\w$]+\??;/g, "")
    .replace(/(?<=[{;])#private;/g, "");
}

/** `export { original as exported } from "from"`; `from` is absent for a local list. */
export interface NamedExport {
  readonly exported: string;
  readonly original: string;
  readonly from: string | undefined;
  readonly typeOnly: boolean;
}

export interface StarExport {
  readonly from: string;
  /** `export * as ns from …` */
  readonly as: string | undefined;
}

/** What one `.d.ts` file declares, exports and re-exports. */
export interface ModuleInfo {
  /** Top-level declarations by local name; merged declarations and overloads share one. */
  readonly declarations: ReadonlyMap<string, readonly DeclarationBlock[]>;
  /** Local names declared with `export` (and `default`). */
  readonly exported: ReadonlySet<string>;
  readonly named: readonly NamedExport[];
  readonly stars: readonly StarExport[];
  /** Local name → where a named import came from. */
  readonly imports: ReadonlyMap<string, { readonly from: string; readonly original: string }>;
  /**
   * `declare module "x"`, `declare global` and nameless export forms: public
   * whenever the file is reachable at all, since they act on import.
   */
  readonly ambient: readonly DeclarationBlock[];
}

const unquote = (literal: string): string => literal.slice(1, -1);

interface ListItem {
  readonly name: string;
  readonly alias: string | undefined;
  readonly typeOnly: boolean;
}

function listItems(list: string): ListItem[] {
  const items: ListItem[] = [];
  for (const item of list.split(",")) {
    const m = /^(type )?([\w$]+)(?: as ([\w$]+))?$/.exec(item);
    if (m !== null) items.push({ name: m[2]!, alias: m[3], typeOnly: m[1] !== undefined });
  }
  return items;
}

/** Parses one `.d.ts` file into {@link ModuleInfo}. */
export function parseModule(text: string): ModuleInfo {
  const declarations = new Map<string, DeclarationBlock[]>();
  const exported = new Set<string>();
  const named: NamedExport[] = [];
  const stars: StarExport[] = [];
  const imports = new Map<string, { readonly from: string; readonly original: string }>();
  const ambient: DeclarationBlock[] = [];
  const declare = (name: string, block: DeclarationBlock): void => {
    declarations.set(name, [...(declarations.get(name) ?? []), block]);
  };

  for (const statement of splitStatements(normalizeDeclarations(text))) {
    const imported = /^import(?: type)?\{(.*)\}from(.+);$/.exec(statement);
    if (imported !== null) {
      for (const item of listItems(imported[1]!)) {
        imports.set(item.alias ?? item.name, { from: unquote(imported[2]!), original: item.name });
      }
      continue;
    }
    if (/^import\b/.test(statement)) continue;

    const star = /^export\*(?:as ([\w$]+) )?from(.+);$/.exec(statement);
    if (star !== null) {
      stars.push({ from: unquote(star[2]!), as: star[1] });
      continue;
    }

    const list = /^export( type)?\{(.*)\}(?:from(.+))?;$/.exec(statement);
    if (list !== null) {
      for (const item of listItems(list[2]!)) {
        named.push({
          exported: item.alias ?? item.name,
          original: item.name,
          from: list[3] === undefined ? undefined : unquote(list[3]),
          typeOnly: list[1] !== undefined || item.typeOnly,
        });
      }
      continue;
    }

    const defaultName = /^export default ([\w$]+);$/.exec(statement);
    if (defaultName !== null) {
      named.push({
        exported: "default",
        original: defaultName[1]!,
        from: undefined,
        typeOnly: false,
      });
      continue;
    }
    if (/^export default\b|^export=/.test(statement)) {
      declare("default", { key: "export default", text: statement });
      exported.add("default");
      continue;
    }

    const head = DECLARATION_HEAD.exec(statement);
    if (head === null) {
      if (/^export\b/.test(statement)) ambient.push({ key: statement, text: statement });
      continue;
    }
    const kind = head[1] === "const enum" ? "enum" : head[1]!;
    const key = head[2] === undefined ? kind : `${kind} ${head[2]}`;
    const block = { key, text: kind === "class" ? stripPrivateMembers(statement) : statement };
    if (kind === "global" || (kind === "module" && /^["']/.test(head[2] ?? ""))) {
      ambient.push(block);
      continue;
    }
    if (head[2] === undefined) continue;
    const isExported = /^export /.test(statement);
    const variable = /^((?:(?:export|declare) )*(?:const|let|var) )(.*);$/.exec(statement);
    if (variable !== null) {
      // `export declare const a: A, b: B;` declares two names; each is its own block.
      for (const declarator of splitTopLevel(variable[2]!, ",")) {
        const name = /^[\w$]+/.exec(declarator)?.[0];
        if (name === undefined) continue;
        declare(name, { key: `${kind} ${name}`, text: `${variable[1]}${declarator};` });
        if (isExported) exported.add(name);
      }
      continue;
    }
    const name = head[2].split(".")[0]!;
    declare(name, block);
    if (isExported) exported.add(name);
  }
  return { declarations, exported, named, stars, imports, ambient };
}

/**
 * The `.d.ts` file a relative specifier names, the way declaration emit spells
 * them: extensionless (`./tabular/Cursor`), a directory (`./ai/index` or
 * `./ai`), or a runtime extension (`./x.js`). A bare specifier is another
 * package and resolves to nothing here.
 */
export function resolveModule(
  files: ReadonlyMap<string, unknown>,
  fromFile: string,
  specifier: string
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier)).replace(/\/$/, "");
  const candidates: string[] = [];
  if (/\.d\.[mc]?ts$/.test(base)) candidates.push(base);
  else if (/\.[mc]?[jt]s$/.test(base)) candidates.push(base.replace(/\.([mc]?)[jt]s$/, ".d.$1ts"));
  // A trailing slash names a directory only.
  if (!specifier.endsWith("/")) candidates.push(`${base}.d.ts`);
  candidates.push(`${base}/index.d.ts`);
  return candidates.find((c) => files.has(c));
}

function toDeclarationPath(target: string): string | undefined {
  const path = target.replace(/^\.\//, "");
  if (/\.d\.[mc]?ts$/.test(path)) return path;
  if (/\.[mc]?js$/.test(path)) return path.replace(/\.([mc]?)js$/, ".d.$1ts");
  return undefined;
}

/**
 * The `.d.ts` files a consumer can import: every `types` target in the
 * `exports` map, or the `.d.ts` beside a runtime target that names none.
 * Without `exports`, `types` / `typings` / `main`. A `*` subpath pattern is
 * expanded against the files that exist.
 */
export function typeEntryPoints(
  manifest: {
    readonly exports?: unknown;
    readonly types?: unknown;
    readonly typings?: unknown;
    readonly main?: unknown;
  },
  files: ReadonlyMap<string, unknown>
): string[] {
  const targets: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === "string") targets.push(node);
    else if (Array.isArray(node)) node.forEach(collect);
    else if (node !== null && typeof node === "object") Object.values(node).forEach(collect);
  };
  if (manifest.exports !== undefined) collect(manifest.exports);
  else collect(manifest.types ?? manifest.typings ?? manifest.main ?? "./index.d.ts");

  const entries = new Set<string>();
  for (const target of targets) {
    const path = toDeclarationPath(target);
    if (path === undefined) continue;
    if (!path.includes("*")) {
      if (files.has(path)) entries.add(path);
      continue;
    }
    const escaped = path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const pattern = new RegExp(`^${escaped}$`);
    for (const file of files.keys()) if (pattern.test(file)) entries.add(file);
  }
  return [...entries].sort();
}

type Binding =
  | {
      readonly kind: "local";
      readonly file: string;
      readonly name: string;
      readonly typeOnly: boolean;
    }
  | { readonly kind: "namespace"; readonly file: string }
  | {
      readonly kind: "external";
      readonly from: string;
      readonly original: string;
      readonly typeOnly: boolean;
    }
  | { readonly kind: "unresolved"; readonly from: string; readonly original: string };

interface SurfaceEntry {
  readonly files: string[];
  readonly texts: string[];
}

/**
 * What a package lets a consumer import, keyed so two versions can be diffed.
 *
 * `declarations` holds two kinds of key. `kind name` (`interface ILimiter`) is
 * a declaration reachable from an entry point, keyed per package rather than
 * per file so one moved between files word for word is not a change; overloads
 * and merged declarations share a key and compare as a set. `export name` is a
 * public name and what it is bound to, which is what catches a rename in a
 * re-export list or a name dropped from a barrel while its declaration lives on.
 */
export interface PackageSurface {
  readonly declarations: ReadonlyMap<string, SurfaceEntry>;
  /** Public names that every entry exporting them re-exports from another package. */
  readonly reexported: ReadonlyMap<string, readonly string[]>;
}

/**
 * The public surface: declarations reachable from `entries` through their
 * exports and relative re-exports, followed transitively. A named re-export
 * list makes only the names it lists reachable.
 *
 * Known limit: a declaration the file does not export but a public one refers
 * to (a local helper type) is not compared; a change to it shows only where it
 * changes the text of something public.
 *
 * @param files `.d.ts` path (relative to the package root) → contents
 * @param entries from {@link typeEntryPoints}
 */
export function buildPublicSurface(
  files: ReadonlyMap<string, string>,
  entries: readonly string[]
): PackageSurface {
  const modules = new Map<string, ModuleInfo>();
  const moduleOf = (file: string): ModuleInfo => {
    let mod = modules.get(file);
    if (mod === undefined) {
      mod = parseModule(files.get(file) ?? "");
      modules.set(file, mod);
    }
    return mod;
  };

  const exportMaps = new Map<string, Map<string, Binding>>();
  const exportsOf = (file: string): ReadonlyMap<string, Binding> => {
    const cached = exportMaps.get(file);
    if (cached !== undefined) return cached;
    const map = new Map<string, Binding>();
    // Registered before it is filled, so an import cycle sees a partial map
    // rather than recursing forever.
    exportMaps.set(file, map);
    const mod = moduleOf(file);

    const via = (from: string, original: string, typeOnly: boolean): Binding => {
      const target = resolveModule(files, file, from);
      if (target === undefined) {
        return from.startsWith(".")
          ? { kind: "unresolved", from, original }
          : { kind: "external", from, original, typeOnly };
      }
      const bound = exportsOf(target).get(original);
      if (bound === undefined) return { kind: "unresolved", from, original };
      return typeOnly && (bound.kind === "local" || bound.kind === "external")
        ? { ...bound, typeOnly: true }
        : bound;
    };

    for (const name of mod.exported) map.set(name, { kind: "local", file, name, typeOnly: false });
    for (const n of mod.named) {
      if (n.from !== undefined) {
        map.set(n.exported, via(n.from, n.original, n.typeOnly));
      } else if (mod.declarations.has(n.original)) {
        map.set(n.exported, { kind: "local", file, name: n.original, typeOnly: n.typeOnly });
      } else {
        const imported = mod.imports.get(n.original);
        map.set(
          n.exported,
          imported === undefined
            ? { kind: "unresolved", from: "", original: n.original }
            : via(imported.from, imported.original, n.typeOnly)
        );
      }
    }
    // Explicit exports win over `export *`, as they do at runtime.
    for (const star of mod.stars) {
      const target = resolveModule(files, file, star.from);
      if (star.as !== undefined) {
        map.set(
          star.as,
          target === undefined
            ? { kind: "external", from: star.from, original: "*", typeOnly: false }
            : { kind: "namespace", file: target }
        );
      } else if (target !== undefined) {
        for (const [name, bound] of exportsOf(target)) {
          if (name !== "default" && !map.has(name)) map.set(name, bound);
        }
      } else {
        map.set(`* from "${star.from}"`, {
          kind: "external",
          from: star.from,
          original: "*",
          typeOnly: false,
        });
      }
    }
    return map;
  };

  const declarations = new Map<string, SurfaceEntry>();
  const add = (key: string, file: string, text: string, unique: boolean): void => {
    const entry = declarations.get(key) ?? { files: [], texts: [] };
    if (!entry.files.includes(file)) entry.files.push(file);
    if (!unique || !entry.texts.includes(text)) entry.texts.push(text);
    declarations.set(key, entry);
  };

  const touchedFiles = new Set<string>();
  const touch = (file: string): void => {
    if (touchedFiles.has(file)) return;
    touchedFiles.add(file);
    for (const block of moduleOf(file).ambient) add(block.key, file, block.text, false);
  };
  const reached = new Set<string>();
  const reach = (bound: Binding): void => {
    if (bound.kind === "local") {
      const id = `${bound.file}\0${bound.name}`;
      if (reached.has(id)) return;
      reached.add(id);
      touch(bound.file);
      for (const block of moduleOf(bound.file).declarations.get(bound.name) ?? []) {
        add(block.key, bound.file, block.text, false);
      }
    } else if (bound.kind === "namespace") {
      const id = `${bound.file}\0*`;
      if (reached.has(id)) return;
      reached.add(id);
      touch(bound.file);
      for (const inner of exportsOf(bound.file).values()) reach(inner);
    }
  };
  const describe = (bound: Binding): string => {
    switch (bound.kind) {
      case "local": {
        const keys = (moduleOf(bound.file).declarations.get(bound.name) ?? []).map((b) => b.key);
        return `${bound.typeOnly ? "type " : ""}${[...new Set(keys)].join(" + ")}`;
      }
      case "namespace":
        return "* as namespace";
      case "external":
        return `${bound.typeOnly ? "type " : ""}${bound.original} from "${bound.from}"`;
      case "unresolved":
        return `unresolved ${bound.original} from "${bound.from}"`;
    }
  };

  const bindingsByName = new Map<string, Binding[]>();
  for (const entry of entries) {
    touch(entry);
    for (const [name, bound] of exportsOf(entry)) {
      add(`export ${name}`, entry, describe(bound), true);
      bindingsByName.set(name, [...(bindingsByName.get(name) ?? []), bound]);
      reach(bound);
    }
  }

  const reexported = new Map<string, string[]>();
  for (const [name, bindings] of bindingsByName) {
    const froms = bindings.flatMap((b) => (b.kind === "external" ? [b.from] : []));
    if (froms.length === bindings.length) reexported.set(name, [...new Set(froms)]);
  }
  return { declarations, reexported };
}

const surfaceText = (entry: SurfaceEntry): string => [...entry.texts].sort().join("\n");

export type SurfaceChange =
  | {
      readonly kind: "added";
      readonly key: string;
      readonly files: readonly string[];
      readonly after: string;
    }
  | {
      readonly kind: "removed";
      readonly key: string;
      readonly files: readonly string[];
      readonly before: string;
    }
  | {
      readonly kind: "changed";
      readonly key: string;
      readonly files: readonly string[];
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly kind: "moved";
      readonly key: string;
      /** The public name, still exported. */
      readonly name: string;
      readonly files: readonly string[];
      readonly before: string;
      /** The specifier it is now re-exported from. */
      readonly to: string;
    };

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
export function packageOfSpecifier(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** The name a surface key is about: `function f` → `f`, `export f` → `f`. */
function nameOfKey(key: string): string {
  return (key.split(" ")[1] ?? "").split(".")[0]!;
}

/**
 * What differs between two surfaces, sorted by key.
 *
 * Only a key the old surface lacked counts as `added`. A member added to an
 * existing interface is a `changed` interface — it is exactly the edit that
 * stops every downstream `implements` compiling.
 *
 * A declaration that is gone, or a public name whose binding changed, is
 * `moved` rather than removed or changed when that name is now re-exported
 * from one of `guardedPackages` — a package whose own surface the same gate
 * run compares, so its signature is checked there. A name that is no longer
 * exported at all is always `removed`.
 */
export function diffSurfaces(
  previous: PackageSurface,
  next: PackageSurface,
  guardedPackages: ReadonlySet<string> = new Set()
): SurfaceChange[] {
  const movedTo = (name: string): string | undefined =>
    next.reexported.get(name)?.find((from) => guardedPackages.has(packageOfSpecifier(from)));
  const changes: SurfaceChange[] = [];
  const keys = new Set([...previous.declarations.keys(), ...next.declarations.keys()]);
  for (const key of [...keys].sort()) {
    const before = previous.declarations.get(key);
    const after = next.declarations.get(key);
    if (before === undefined && after !== undefined) {
      changes.push({ kind: "added", key, files: after.files, after: surfaceText(after) });
      continue;
    }
    if (before === undefined) continue;
    const b = surfaceText(before);
    if (after !== undefined && surfaceText(after) === b) continue;
    const name = nameOfKey(key);
    const isBinding = key.startsWith("export ");
    // A binding that vanished is a name that is no longer exported: never a move.
    const to = isBinding && after === undefined ? undefined : movedTo(name);
    if (to !== undefined) {
      changes.push({ kind: "moved", key, name, files: before.files, before: b, to });
    } else if (after === undefined) {
      changes.push({ kind: "removed", key, files: before.files, before: b });
    } else {
      changes.push({
        kind: "changed",
        key,
        files: after.files,
        before: b,
        after: surfaceText(after),
      });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string;
}

export function parseSemver(version: string): SemVer | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (m === null) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? "" };
}

function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === "") return 1;
  if (b.prerelease === "") return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/**
 * The version a release is measured against: the highest stable version on
 * the registry below the one being cut.
 *
 * Read from the registry rather than from a git tag or the changelog because
 * the registry is what a consumer's range resolves against — a release that was
 * tagged but refused before publishing is not a baseline anyone installed.
 */
export function previousPublishedVersion(
  published: readonly string[],
  next: string
): string | undefined {
  const target = parseSemver(next);
  if (target === undefined) return undefined;
  let best: { readonly raw: string; readonly v: SemVer } | undefined;
  for (const raw of published) {
    const v = parseSemver(raw);
    if (v === undefined || v.prerelease !== "") continue;
    if (compareSemver(v, target) >= 0) continue;
    if (best === undefined || compareSemver(v, best.v) > 0) best = { raw, v };
  }
  return best?.raw;
}

/**
 * Whether `next` stays inside `previous`'s caret range — the bump a consumer
 * picks up without asking.
 *
 * On a 0.x line `^0.6.8` admits only `0.6.x`, so the minor is the break slot
 * (0.5.0 went out as a minor for the `join()` break for that reason); from
 * 1.0 on it is the major. `^0.0.3` admits nothing else at all.
 */
export function isBelowBreakSlot(previous: string, next: string): boolean {
  const p = parseSemver(previous);
  const n = parseSemver(next);
  if (p === undefined || n === undefined) return true;
  if (p.major > 0) return n.major === p.major;
  if (p.minor > 0) return n.major === 0 && n.minor === p.minor;
  return false;
}

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

/** The `## <version>` section of a CHANGELOG.md, heading included. */
export function readChangelogEntry(changelog: string, version: string): string | undefined {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return undefined;
  let end = start + 1;
  while (end < lines.length && !/^## /.test(lines[end]!)) end++;
  return lines.slice(start, end).join("\n");
}

/** Whether the entry declares a break, as bunset writes one. */
export function declaresBreakingChanges(entry: string | undefined): boolean {
  return entry !== undefined && /^### Breaking Changes\s*$/m.test(entry);
}

/** One package bunset is about to version. */
export interface PlannedRelease {
  readonly name: string;
  readonly nextVersion: string;
  readonly changelogEntry: string | undefined;
}

const PLAN_LINE = /^(@[\w.-]+\/[\w.-]+|[\w.-]+): (\S+) → (\S+) \((\w+)\)$/;
const ENTRY_LINE = /^Changelog entry for (\S+):$/;
const PLAN_END =
  /^(?:\(workspace root\):|Would commit:|Will not commit|Would tag:|Files that would)/;

/**
 * The versions and changelog entries `bunset --dry-run` prints.
 *
 * Each package is a `name: old → new (bump)` line followed by
 * `Changelog entry for name:` and the entry. Parsing stops at the commit
 * preview, which repeats the entries as release notes.
 */
export function parseBunsetDryRun(output: string): PlannedRelease[] {
  const versions = new Map<string, string>();
  const entries = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of output.split("\n")) {
    if (PLAN_END.test(line)) break;
    const plan = PLAN_LINE.exec(line);
    if (plan !== null) {
      versions.set(plan[1]!, plan[3]!);
      current = undefined;
      continue;
    }
    const entry = ENTRY_LINE.exec(line);
    if (entry !== null) {
      current = [];
      entries.set(entry[1]!, current);
      continue;
    }
    current?.push(line);
  }
  return [...versions].map(([name, nextVersion]) => ({
    name,
    nextVersion,
    changelogEntry: entries.get(name)?.join("\n").trim(),
  }));
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export interface SurfaceBumpInput {
  readonly name: string;
  /** `undefined` when nothing has been published below `nextVersion`. */
  readonly previousVersion: string | undefined;
  readonly nextVersion: string;
  readonly changes: readonly SurfaceChange[];
  readonly changelogEntry: string | undefined;
}

export type SurfaceBumpVerdict =
  | {
      readonly ok: true;
      readonly why:
        | "unpublished"
        | "already-published"
        | "unchanged"
        | "additive"
        | "break-slot"
        | "declared-breaking";
    }
  | {
      readonly ok: false;
      readonly name: string;
      readonly previousVersion: string;
      readonly nextVersion: string;
      readonly changes: readonly SurfaceChange[];
    };

/**
 * Refuses a release that changes or removes a published declaration while its
 * number stays inside the previous version's caret range, unless the package's
 * changelog entry for it carries `### Breaking Changes`.
 *
 * A new top-level declaration passes on its own: nothing downstream could have
 * depended on its absence, and so does a `moved` one, whose signature the
 * package it moved to answers for. A new member of an existing interface does
 * not — see {@link diffSurfaces}.
 */
export function evaluateSurfaceBump(input: SurfaceBumpInput): SurfaceBumpVerdict {
  if (input.previousVersion === undefined) return { ok: true, why: "unpublished" };
  if (input.changes.length === 0) return { ok: true, why: "unchanged" };
  const breaking = input.changes.filter((c) => c.kind === "removed" || c.kind === "changed");
  if (breaking.length === 0) return { ok: true, why: "additive" };
  if (!isBelowBreakSlot(input.previousVersion, input.nextVersion)) {
    return { ok: true, why: "break-slot" };
  }
  if (declaresBreakingChanges(input.changelogEntry)) return { ok: true, why: "declared-breaking" };
  return {
    ok: false,
    name: input.name,
    previousVersion: input.previousVersion,
    nextVersion: input.nextVersion,
    changes: breaking,
  };
}

// ---------------------------------------------------------------------------
// Refusal text
// ---------------------------------------------------------------------------

const MAX_SPAN = 200;

/** Puts back enough spacing to read normalized text; display only. */
function readable(text: string): string {
  return text
    .replace(/([;,])(?=\S)/g, "$1 ")
    .replace(/\{(?=\S)/g, "{ ")
    .replace(/(?<=\S)\}/g, " }")
    .replace(/(?<=[^\s=])=>(?=\S)/g, " => ");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const MAX_MEMBERS_SHOWN = 4;

/**
 * The members that differ between two versions of one declaration.
 *
 * Both texts are cut at member boundaries (`;`, `{`, `}`) and compared as
 * multisets, so a narrowed return type reads as the whole member, old and new,
 * and an added member reads as that member alone — however far apart the
 * edits in one class body are.
 */
export function excerptChange(
  before: string,
  after: string
): { readonly removed: readonly string[]; readonly added: readonly string[] } {
  const pieces = (text: string): string[] => text.split(/(?<=[;{}])/).filter((p) => p !== "");
  const only = (from: string[], other: string[]): string[] => {
    const remaining = new Map<string, number>();
    for (const p of other) remaining.set(p, (remaining.get(p) ?? 0) + 1);
    return from.filter((p) => {
      const n = remaining.get(p) ?? 0;
      if (n === 0) return true;
      remaining.set(p, n - 1);
      return false;
    });
  };
  const b = pieces(before);
  const a = pieces(after);
  const show = (list: string[]): string[] => list.map((p) => clip(readable(p), MAX_SPAN));
  return { removed: show(only(b, a)), added: show(only(a, b)) };
}

const MAX_CHANGES_SHOWN = 8;

/** Per package: the versions, then each changed or removed declaration and where it lives. */
export function formatSurfaceRefusal(
  refusals: readonly Extract<SurfaceBumpVerdict, { ok: false }>[]
): string {
  const out: string[] = [];
  for (const r of refusals) {
    out.push(`  ${r.name} ${r.previousVersion} → ${r.nextVersion}`);
    // Interfaces first: a changed interface breaks every downstream `implements`,
    // which is the case this gate exists for.
    const ordered = [...r.changes].sort(
      (a, b) => Number(!a.key.startsWith("interface ")) - Number(!b.key.startsWith("interface "))
    );
    for (const change of ordered.slice(0, MAX_CHANGES_SHOWN)) {
      out.push(`    ${change.kind} ${change.key}  (${change.files.join(", ")})`);
      if (change.kind === "changed") {
        const x = excerptChange(change.before, change.after);
        const lines = [
          ...x.removed.map((m) => `      - ${m}`),
          ...x.added.map((m) => `      + ${m}`),
        ];
        out.push(...lines.slice(0, MAX_MEMBERS_SHOWN * 2));
        if (lines.length > MAX_MEMBERS_SHOWN * 2) {
          out.push(`      … and ${lines.length - MAX_MEMBERS_SHOWN * 2} more members`);
        }
      } else if (change.kind === "removed") {
        out.push(`      - ${clip(readable(change.before), MAX_SPAN)}`);
      }
    }
    const rest = r.changes.length - MAX_CHANGES_SHOWN;
    if (rest > 0) out.push(`    … and ${rest} more`);
  }
  return out.join("\n");
}
