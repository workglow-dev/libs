/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every condition branch in an `exports` map that names an implementation must
 * declare the `types` target belonging to the implementation named *in that same
 * branch*. A branch whose `types` names a different target hands TypeScript the
 * wrong module: browser consumers of `@workglow/openai/ai` were type-checked
 * against the node build, which exports `_testOnly`,
 * `registerOpenAiImageValidator` and `OpenAI_ModelSearch_Stream` — symbols the
 * browser bundle genuinely does not export.
 *
 * A branch that declares no `types` is not typed by an outer one: resolution
 * stops at the branch that matched, and TypeScript then looks for a declaration
 * beside the resolved implementation (`.js` -> `.d.ts`). Declaring it explicitly
 * is what makes the pairing checkable here, and what survives a build that emits
 * the implementation without an adjacent declaration.
 */

/** Keys whose value is the module a runtime loads, in resolution order. */
const IMPLEMENTATION_KEYS = ["import", "require", "default"] as const;

/**
 * A string branch value that is a module rather than a plain asset, so
 * `"./package.json": "./package.json"` is not treated as a missing declaration.
 */
const MODULE_PATH = /\.[cm]?js$/;

/**
 * Branches exempt from the pairing rule, by label. An entry silences that
 * branch's violation whichever kind it is — a `types` naming a different target,
 * or an implementation with no `types` beside it. Each entry must say why the
 * declaration genuinely describes the other file. Empty on purpose: do not add
 * an entry to silence drift — fix the manifest, or emit the missing declaration.
 */
const ALLOWED_MISMATCHES: ReadonlySet<string> = new Set<string>([]);

interface BranchLocation {
  readonly manifest: string;
  readonly subpath: string;
  readonly condition: string;
  /**
   * Which of {@link IMPLEMENTATION_KEYS} named this implementation, or
   * `undefined` for the string-shorthand form where the condition's own value
   * IS the implementation and there is no separate key.
   *
   * Part of the identity because one object can now yield several branches —
   * `{types, require, default}` produces one per string-valued implementation
   * key — and they would otherwise share a label, colliding as the key for
   * `ALLOWED_MISMATCHES` and the staleness check.
   */
  readonly implementationKey: string | undefined;
  readonly implementation: string;
  readonly expectedTypes: string;
}

/**
 * A branch that declares `types`. It can only fail by naming the wrong
 * declaration, so its violation reason is fixed at collection time.
 */
interface DeclaredBranch extends BranchLocation {
  readonly reason: "mismatch";
  readonly types: string;
  /** Whether `types` precedes the implementation key in the same object. */
  readonly typesBeforeImplementation: boolean;
}

/** A branch naming an implementation with no `types` beside it. */
interface UndeclaredBranch extends BranchLocation {
  readonly reason: "missing";
  readonly types: undefined;
}

type Branch = DeclaredBranch | UndeclaredBranch;

/**
 * TypeScript honors a declaration extension only when it matches the module's:
 * `.cjs` is described by `.d.cts` and `.mjs` by `.d.mts`, not by `.d.ts`.
 */
function declarationFor(implementation: string): string {
  if (implementation.endsWith(".cjs")) return implementation.replace(/\.cjs$/, ".d.cts");
  if (implementation.endsWith(".mjs")) return implementation.replace(/\.mjs$/, ".d.mts");
  return implementation.replace(/\.js$/, ".d.ts");
}

/** Source entry extensions a `dist` target can be built from. */
const SOURCE_ENTRY_EXTENSIONS = [".ts", ".tsx"] as const;

/** `./dist/<stem>.<ext>` -> `<stem>`, or undefined for a layout this rule cannot describe. */
function distStem(target: string): string | undefined {
  return /^\.\/dist\/(.+?)(?:\.d\.ts|\.d\.cts|\.d\.mts|\.js|\.cjs|\.mjs)$/.exec(target)?.[1];
}

/** Repo-relative source entry candidates for a target declared by `manifest`. */
function sourceCandidates(manifest: string, target: string): readonly string[] | undefined {
  const stem = distStem(target);
  if (stem === undefined) return undefined;
  const packageDir = dirname(manifest);
  return SOURCE_ENTRY_EXTENSIONS.map((ext) => `${packageDir}/src/${stem}${ext}`);
}

function collectBranches(
  manifest: string,
  subpath: string,
  conditionPath: readonly string[],
  node: unknown,
  out: Branch[]
): void {
  const condition = conditionPath.join(" > ") || "(default)";
  // Shorthand: the condition's value *is* the implementation, so nothing beside
  // it can declare types; TypeScript falls back to the declaration adjacent to
  // the resolved file rather than to an outer `types`.
  if (typeof node === "string") {
    if (MODULE_PATH.test(node)) {
      out.push({
        manifest,
        subpath,
        condition,
        implementationKey: undefined,
        types: undefined,
        reason: "missing",
        implementation: node,
        expectedTypes: declarationFor(node),
      });
    }
    return;
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) return;
  const entry = node as Record<string, unknown>;
  // EVERY string-valued implementation key, not just the first. A dual-package
  // object writes them flat — `{types, import: "./a.mjs", require: "./a.cjs"}` —
  // and taking only `import` left `require` unchecked, so a `.cjs` paired with a
  // `.d.ts` sailed through. The file's own `.cjs` fixtures use the nested form,
  // which is why the flat shape was never exercised.
  const implementationKeys = IMPLEMENTATION_KEYS.filter((key) => typeof entry[key] === "string");
  const keys = Object.keys(entry);
  for (const implementationKey of implementationKeys) {
    const implementation = entry[implementationKey] as string;
    const location: BranchLocation = {
      manifest,
      subpath,
      condition,
      implementationKey,
      implementation,
      expectedTypes: declarationFor(implementation),
    };
    const types = entry.types;
    out.push(
      typeof types === "string"
        ? {
            ...location,
            types,
            reason: "mismatch",
            // Node stops at the first matching condition, so a `types` declared
            // after the implementation key is never reached.
            typesBeforeImplementation: keys.indexOf("types") < keys.indexOf(implementationKey),
          }
        : { ...location, types: undefined, reason: "missing" }
    );
  }
  for (const [key, value] of Object.entries(entry)) {
    if (key === "types") continue;
    // An implementation key holding a string is this branch's implementation,
    // already recorded above. Holding an object it is a nested condition — the
    // `{ "import": { "types": …, "default": … } }` dual-package form — and its
    // pairing has to be checked like any other branch's.
    const isImplementationString =
      (IMPLEMENTATION_KEYS as readonly string[]).includes(key) && typeof value === "string";
    if (isImplementationString) continue;
    collectBranches(manifest, subpath, [...conditionPath, key], value, out);
  }
}

function label(branch: Branch): string {
  const key = branch.implementationKey === undefined ? "" : ` > ${branch.implementationKey}`;
  return `${branch.manifest} exports["${branch.subpath}"] [${branch.condition}${key}]`;
}

function isViolation(branch: Branch): boolean {
  if (branch.reason === "missing") return true;
  return branch.types !== branch.expectedTypes;
}

function violationMessage(branch: Branch): string {
  if (branch.reason === "missing") {
    return (
      `${label(branch)}: implementation "${branch.implementation}" declares no types ` +
      `(expected types="${branch.expectedTypes}")`
    );
  }
  return (
    `${label(branch)}: types="${branch.types}" but implementation is ` +
    `"${branch.implementation}" (expected types="${branch.expectedTypes}")`
  );
}

function branchesFor(manifest: string, exportsMap: Record<string, unknown>): Branch[] {
  const branches: Branch[] = [];
  for (const [subpath, value] of Object.entries(exportsMap)) {
    collectBranches(manifest, subpath, [], value, branches);
  }
  return branches;
}

/** Every branch of one `exports` map that pairs its implementation wrongly. */
function findViolations(manifest: string, exportsMap: Record<string, unknown>): string[] {
  return branchesFor(manifest, exportsMap)
    .filter(isViolation)
    .filter((branch) => !ALLOWED_MISMATCHES.has(label(branch)))
    .map(violationMessage);
}

/**
 * Conditions a plain `import` under Node matches, in the order Node tries
 * them. `browser`, `bun` and `react-native` are deliberately absent: the point
 * is to find the target a NODE consumer lands on, which is what a browser split
 * has to differ from.
 */
const NODE_IMPORT_CONDITIONS: ReadonlySet<string> = new Set(["node", "import", "default"]);

/**
 * The implementation a plain Node `import` of one subpath resolves to, or
 * `undefined` when nothing in the branch resolves under Node's conditions.
 * `types` is skipped because Node does not know that condition — only
 * TypeScript does.
 */
function nodeImportTarget(node: unknown): string | undefined {
  if (typeof node === "string") return MODULE_PATH.test(node) ? node : undefined;
  if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "types" || !NODE_IMPORT_CONDITIONS.has(key)) continue;
    const resolved = nodeImportTarget(value);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/** Every implementation string reachable inside one condition branch. */
function implementationsIn(node: unknown, out: string[]): void {
  if (typeof node === "string") {
    if (MODULE_PATH.test(node)) out.push(node);
    return;
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "types") continue;
    implementationsIn(value, out);
  }
}

/**
 * The `browser` block of one subpath, wherever it is nested.
 *
 * A top-level `value.browser` lookup finds only the flat shape. Its sibling
 * {@link nodeImportTarget} recurses, so the two disagreed about the same
 * manifest: `{ "import": { "browser": {…}, "default": … } }` resolves its node
 * target through the recursion while the browser block sat one level down,
 * invisible — every rule keyed on `branch` then behaved as if the subpath
 * declared no `browser` condition at all, which is the "reports a built browser
 * entry that no condition routes to" message pointed at a manifest that does
 * route to one.
 *
 * The first block found wins: resolution stops at the first matching condition,
 * so a second `browser` deeper in a sibling branch is unreachable anyway.
 */
function findBrowserBlock(node: unknown): unknown {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
  const entry = node as Record<string, unknown>;
  if ("browser" in entry) return entry.browser;
  for (const [key, value] of Object.entries(entry)) {
    // `types` is TypeScript's, never a runtime's, so a `browser` under it would
    // not be entered by the bundler this rule is about.
    if (key === "types") continue;
    const found = findBrowserBlock(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Subpaths that have a browser source entry beside them but do not route
 * browser consumers to it.
 *
 * Every other check in this file is internally self-consistent — it compares a
 * branch against itself — so a `browser` block that is a byte-for-byte copy of
 * the default branch passes all six while sending browser consumers to the NODE
 * bundle. That shape exists in the repo today (`providers/chrome-ai`,
 * `providers/tf-mediapipe`), where it is inert because neither package HAS a
 * browser source entry: the two bundles are legitimately the same file. The
 * source entry is what turns the duplicate into a bug, so it is what this rule
 * keys on — and why the probe is injected rather than performed here, so
 * fixtures can drive both sides of it.
 *
 * One case is decided BEFORE that probe: a `browser` block declaring only
 * `types` and no implementation. `collectBranches` records a branch only when a
 * string-valued implementation key is present, so such a block produces no
 * branch at all and is invisible to every other rule in this file — including
 * the source-entry rule, which can only check targets a branch declared.
 * Bundlers, meanwhile, enter the `browser` condition, match nothing in it, and
 * fall through to the node target: the browser-typed-as-node inversion this
 * file exists to prevent, reached by omission instead of by a wrong target.
 * Hoisting it past the source-entry guard is deliberate — the `packages/*`
 * layout (stem `node`, no `src/node.browser.ts`) never reaches the guarded code
 * and would otherwise carry the same bug unreported.
 */
function browserSplitViolations(
  manifest: string,
  exportsMap: Record<string, unknown>,
  hasSourceEntry: (repoRelativePath: string) => boolean
): string[] {
  const out: string[] = [];
  const packageDir = dirname(manifest);
  for (const [subpath, value] of Object.entries(exportsMap)) {
    const nodeTarget = nodeImportTarget(value);
    if (nodeTarget === undefined) continue;
    const at = `${manifest} exports["${subpath}"]`;
    const branch = findBrowserBlock(value);

    if (branch !== undefined) {
      const declared: string[] = [];
      implementationsIn(branch, declared);
      if (declared.length === 0) {
        out.push(
          `${at} [browser]: the "browser" condition declares no implementation, so a browser ` +
            `bundler enters it, matches nothing, and falls through to the node target ` +
            `"${nodeTarget}"`
        );
        continue;
      }
    }

    const stem = distStem(nodeTarget);
    if (stem === undefined) continue;
    const browserEntry = SOURCE_ENTRY_EXTENSIONS.map(
      (ext) => `${packageDir}/src/${stem}.browser${ext}`
    );
    // No browser source entry: the packages under `packages/*` land here (stem
    // `node`, no `src/node.browser.ts`), as do the byte-duplicate provider
    // blocks. Nothing to split, so nothing to say.
    if (!browserEntry.some((candidate) => hasSourceEntry(candidate))) continue;

    const expected = `./dist/${stem}.browser.js`;
    if (branch === undefined) {
      out.push(
        `${at}: ${browserEntry[0]} exists but no "browser" condition is declared, so browser ` +
          `consumers resolve the node bundle "${nodeTarget}" (expected "${expected}")`
      );
      continue;
    }
    const implementations: string[] = [];
    implementationsIn(branch, implementations);
    for (const implementation of implementations) {
      if (implementation === expected) continue;
      out.push(
        `${at} [browser]: implementation "${implementation}" is not the browser bundle, but ` +
          `${browserEntry[0]} exists (expected "${expected}")`
      );
    }
  }
  return out;
}

/**
 * One `<stem>.browser.ts` and the `<stem>.ts` beside it, as text — anywhere
 * under `src`, not only at the entry layer.
 *
 * Injected rather than read inside the rule so the fixtures below can state
 * both halves, the same way {@link browserSplitViolations} takes its probe.
 */
interface EntryPair {
  readonly browserPath: string;
  readonly nodePath: string;
  readonly browserText: string;
  readonly nodeText: string;
}

/**
 * The part of an entry file that decides what it exports. Block comments (the
 * license header), whole-line `//` comments (`organize-imports-ignore`, and any
 * prose explaining the entry) and whitespace are boilerplate every entry
 * carries, so two entries differing only in those are the same module — and a
 * comment alone can never talk this rule out of a real duplicate.
 */
function entryBody(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every module specifier the entry names, in source order. */
function specifiersIn(text: string): string[] {
  return [...text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] as string);
}

/**
 * Browser modules that are a copy of the node module beside them AND name only
 * relative specifiers.
 *
 * The rule reads every `<stem>.browser.ts` under `src`, not just the entry
 * layer the manifests name: a nominal split is the same defect one directory
 * down (`providers/openrouter/src/ai/runtime.browser.ts` was a byte copy of
 * `runtime.ts`), and the entry-only scan could not see it.
 *
 * **The relative/bare distinction is the entire rule.** Two identical files
 * mean opposite things depending on what they import:
 *
 * - A **relative** specifier (`"./ai/index"`) is resolved once, by the file's
 *   own path, and nothing in this toolchain substitutes `X.browser.ts` for
 *   `X.ts` on one (`--target=browser` changes the compile target, not the
 *   resolver; the `browser` field in a manifest applies to BARE specifiers).
 *   So both entries pull in the same module graph and the declaration split is
 *   nominal — two `.d.ts` files that must be hand-kept in sync, with nothing
 *   but diligence stopping them drifting. `providers/llamacpp-server` and
 *   `providers/stable-diffusion-server` were exactly this. The fix is for the
 *   browser entry to `export * from "./ai"`, which cannot drift.
 *
 * - A **bare** specifier (`"@workglow/openai/ai"`) is re-resolved at every hop
 *   under the CONSUMER's conditions, so the two identical files land on
 *   different modules: the split really happens one layer down, in the
 *   provider's own exports map. The nine `packages/workglow/src/*.browser.ts`
 *   shims are this shape, and their being byte-identical IS the mechanism —
 *   collapsing one into `export * from "./openai"` would pin browser consumers
 *   to whatever the shim's own condition resolved and destroy the split. They
 *   must stay identical; this rule must never report them.
 *
 * A pair with no specifiers at all is not reported: there is no import graph to
 * reason about, so "the two resolve the same graph" says nothing.
 */
function duplicateBrowserEntryViolations(pairs: readonly EntryPair[]): string[] {
  const out: string[] = [];
  for (const pair of pairs) {
    const browserBody = entryBody(pair.browserText);
    if (browserBody !== entryBody(pair.nodeText)) continue;
    const specifiers = specifiersIn(browserBody);
    if (specifiers.length === 0) continue;
    if (!specifiers.every((specifier) => specifier.startsWith("."))) continue;
    out.push(
      `${pair.browserPath} is identical to ${pair.nodePath} and names only relative ` +
        `specifiers (${specifiers.map((specifier) => `"${specifier}"`).join(", ")}), so both ` +
        `entries resolve the same module graph and the declaration split is nominal — ` +
        `re-export the node entry from it instead of duplicating it`
    );
  }
  return out;
}

/**
 * Packages whose `build*` scripts drive their entries from a glob rather than
 * from a written-out list, so there is no entry text for
 * {@link buildEntryViolations} to read.
 *
 * Pinned to a set of one, and guarded below by a test that each exempted
 * package really does hand its build off to a repo-local `*.ts` program — so
 * the exemption dies the moment that package goes back to naming its entries,
 * rather than quietly exempting a hand-written list from the rule.
 */
const GLOB_BUILT_PACKAGES: ReadonlySet<string> = new Set(["packages/workglow/package.json"]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether any `build*` script passes `src/<stem>.ts(x)` as an entry.
 *
 * Matched as a WHOLE TOKEN — optional `./`, bounded by whitespace or the end of
 * the script — and both halves of that are load-bearing:
 *
 * - `bun build --outdir ./dist/storage ./src/storage/browser.ts` has to satisfy
 *   the stem `storage/browser` that its nested `--outdir` produces, so the
 *   match is on the whole `src/`-relative path rather than on a basename; and
 * - `./src/ai.browser.ts` must NOT satisfy the stem `ai`. A substring test would
 *   let a package that builds only its browser entry pass while declaring the
 *   node one, which is the exact miss this rule exists to catch.
 */
function buildsSourceEntry(buildScriptText: string, stem: string): boolean {
  return new RegExp(`(^|\\s)\\.?/?src/${escapeRegExp(stem)}\\.tsx?(\\s|$)`).test(buildScriptText);
}

/**
 * Implementation targets no `build*` script builds a source entry for.
 *
 * The source-entry rule below proves only the DECLARATION half. `build-types`
 * runs `tsgo` over the package's whole `src` tree, so every source file yields
 * a `.d.ts` whether or not anything lists it; the `.js` half comes from the
 * hand-written entry lists in each package's `build-code` / `build-browser` /
 * `build-*` scripts, which nothing read. Add `providers/foo/src/ai.browser.ts`
 * and a `browser` block, forget to append `./src/ai.browser.ts` to
 * `build-browser`, and every other check here passes while
 * `dist/ai.browser.js` is never emitted — the package publishes a `browser`
 * condition pointing at a file that does not exist.
 *
 * This is checked HERE, in the file that reviews the manifest, rather than as a
 * prepack assertion in `publish-workspaces.ts`: a prepack assertion fires after
 * review and after merge, and the defect being fixed is a guard test that does
 * not guard what it claims. It has to be able to fail the PR that introduces it.
 */
function buildEntryViolations(
  manifest: string,
  exportsMap: Record<string, unknown>,
  scripts: Readonly<Record<string, string>>
): string[] {
  const buildScriptText = Object.entries(scripts)
    .filter(([name]) => name.startsWith("build"))
    .map(([, body]) => body)
    .join("\n");

  // First subpath wins, so one target shared by several subpaths is reported
  // once — the fix is one entry line either way.
  const declaredAt = new Map<string, string>();
  for (const [subpath, value] of Object.entries(exportsMap)) {
    const targets: string[] = [];
    implementationsIn(value, targets);
    for (const target of targets) if (!declaredAt.has(target)) declaredAt.set(target, subpath);
  }

  const out: string[] = [];
  for (const [target, subpath] of declaredAt) {
    const at = `${manifest} exports["${subpath}"]`;
    const stem = distStem(target);
    // Reported, not skipped: a layout the derivation cannot describe is exactly
    // where an unbuilt target would hide.
    if (stem === undefined) {
      out.push(`${at}: "${target}" is not ./dist/<stem>.<ext>, so no source entry is derivable`);
      continue;
    }
    if (buildsSourceEntry(buildScriptText, stem)) continue;
    out.push(
      `${at}: "${target}" is declared but no build* script names its source entry ` +
        `(expected src/${stem}.ts among the entries passed to a build command)`
    );
  }
  return out;
}

/**
 * Whether a value is selected unconditionally, so a runtime can never fall past
 * it to a later sibling. A string target always is. An object is only when one
 * of its own implementation keys resolves — a nested object holding nothing but
 * further conditions (`{ browser: … }`) leaves a runtime free to fall through.
 */
function resolvesUnconditionally(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return IMPLEMENTATION_KEYS.some((key) => key in entry && resolvesUnconditionally(entry[key]));
}

function isImplementationString(entry: Record<string, unknown>, key: string): boolean {
  return (IMPLEMENTATION_KEYS as readonly string[]).includes(key) && typeof entry[key] === "string";
}

/**
 * Whether this key shadows the siblings declared after it. String-valued
 * implementation keys always did; an implementation key holding an OBJECT does
 * too whenever that object resolves unconditionally, which a string-only test
 * missed — `{ "import": { default: … }, "browser": … }` reads as two conditions
 * and behaves as one dead branch.
 */
function isShadowingImplementation(entry: Record<string, unknown>, key: string): boolean {
  return (
    (IMPLEMENTATION_KEYS as readonly string[]).includes(key) && resolvesUnconditionally(entry[key])
  );
}

/**
 * Condition keys made unreachable by a SIBLING declared before them.
 *
 * The pairing rule and its `typesBeforeImplementation` flag both look inside a
 * single object, so they see nothing wrong with a map whose branches are
 * individually well formed but ordered so that one can never be selected.
 * Resolution stops at the first key that matches, so:
 *
 * - `{types, browser: {…}, import}` — TypeScript matches the outer `types` and
 *   never looks at `browser`, which is exactly the browser-typed-as-node bug
 *   this file exists to prevent, expressed through ordering instead of through
 *   a wrong target; and
 * - `{import, browser: {…}}` — a runtime honoring `browser` still matches
 *   `import` first, so the browser build never loads.
 *
 * Both shapes yield `violations: []` and `late: []` from the existing checks.
 *
 * The string-shorthand form (`browser: "./dist/x.js"`) is included: it is just
 * as dead as the object form, and this repo demonstrably writes it.
 */
function orderViolations(manifest: string, exportsMap: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (subpath: string, conditionPath: readonly string[], node: unknown): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const entry = node as Record<string, unknown>;
    const keys = Object.keys(entry);
    const typesIndex = keys.indexOf("types");
    const implementationIndex = keys.findIndex((key) => isShadowingImplementation(entry, key));
    const where = conditionPath.join(" > ") || "(default)";
    const at = `${manifest} exports["${subpath}"] [${where}]`;

    keys.forEach((key, index) => {
      // Only condition keys can be shadowed. `types` and the implementation
      // strings are the things that DO the shadowing.
      if (key === "types" || isImplementationString(entry, key)) return;
      if (typesIndex >= 0 && typesIndex < index) {
        out.push(
          `${at}: condition "${key}" is declared after "types", so TypeScript resolves ` +
            `"types" first and "${key}" is never reached`
        );
      }
      if (implementationIndex >= 0 && implementationIndex < index) {
        out.push(
          `${at}: condition "${key}" is declared after "${keys[implementationIndex]}", so ` +
            `resolution stops there and "${key}" is never reached`
        );
      }
    });

    for (const [key, value] of Object.entries(entry)) {
      if (key === "types" || typeof value === "string") continue;
      walk(subpath, [...conditionPath, key], value);
    }
  };
  for (const [subpath, value] of Object.entries(exportsMap)) {
    walk(subpath, [], value);
  }
  return out;
}

interface WorkspaceRoot {
  readonly dir: string;
  /** Directories holding workspace packages, from the root `workspaces` globs. */
  readonly groups: readonly string[];
}

function workspaceRoot(): WorkspaceRoot {
  // Walk up from this file until the workspace root manifest is found.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { workspaces?: unknown };
      if (Array.isArray(pkg.workspaces)) {
        const groups = pkg.workspaces
          .filter((pattern): pattern is string => typeof pattern === "string")
          .map((pattern) => pattern.replace(/^\.\//, "").replace(/\/\*+$/, ""))
          .filter((group) => !group.includes("*"));
        return { dir, groups };
      }
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate the workspace root from " + import.meta.url);
}

/** Every workspace manifest, as a repo-root-relative path. */
function workspaceManifests(root: WorkspaceRoot): string[] {
  const manifests: string[] = [];
  for (const group of root.groups) {
    const groupDir = join(root.dir, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(groupDir, entry.name, "package.json"))) {
        manifests.push(`${group}/${entry.name}/package.json`);
      }
    }
  }
  return manifests.sort();
}

interface Manifest {
  readonly relative: string;
  readonly exports: Record<string, unknown>;
  /** The manifest's `scripts`, which is where the build entry lists live. */
  readonly scripts: Readonly<Record<string, string>>;
}

function manifestsWithExports(root: WorkspaceRoot): Manifest[] {
  const found: Manifest[] = [];
  for (const relative of workspaceManifests(root)) {
    const pkg = JSON.parse(readFileSync(join(root.dir, relative), "utf8")) as {
      exports?: Record<string, unknown>;
      scripts?: Record<string, unknown>;
    };
    if (!pkg.exports) continue;
    const scripts: Record<string, string> = {};
    for (const [name, body] of Object.entries(pkg.scripts ?? {})) {
      if (typeof body === "string") scripts[name] = body;
    }
    found.push({ relative, exports: pkg.exports, scripts });
  }
  return found;
}

describe("workspace exports maps", () => {
  const root = workspaceRoot();
  const manifests = manifestsWithExports(root);
  const branches = manifests.flatMap((manifest) =>
    branchesFor(manifest.relative, manifest.exports)
  );

  it("finds condition branches to check", () => {
    // Guards against the scan silently finding nothing and the suite passing vacuously.
    expect(branches.length).toBeGreaterThan(50);
  });

  it("pairs every `types` target with the implementation beside it", () => {
    const violations = manifests.flatMap((manifest) =>
      findViolations(manifest.relative, manifest.exports)
    );
    expect(violations).toEqual([]);
  });

  it("declares only targets a source entry file can emit", () => {
    // Pairing alone cannot see a self-consistent branch for a build that does not
    // exist — copying another package's `browser` block declares a `.d.ts`/`.js`
    // pair naming each other correctly while nothing emits either file.
    //
    // A source entry beside them is NECESSARY for either half and sufficient for
    // only one: `build-types` runs `tsgo` over the package's whole `src` tree, so
    // the existence of the file is exactly what makes the `.d.ts` appear, but the
    // `.js` comes from a hand-written entry list in a `build*` script that this
    // check never reads. `buildEntryViolations` is what covers that half; keep
    // the two together, because passing this one alone proves only that the
    // declaration will be emitted.
    const unrecognized: string[] = [];
    const missing: string[] = [];
    for (const branch of branches) {
      for (const target of [branch.types, branch.implementation]) {
        if (target === undefined) continue;
        const candidates = sourceCandidates(branch.manifest, target);
        if (candidates === undefined) {
          unrecognized.push(`${label(branch)}: "${target}" is not ./dist/<stem>.<ext>`);
          continue;
        }
        if (candidates.some((candidate) => existsSync(join(root.dir, candidate)))) continue;
        missing.push(
          `${label(branch)}: "${target}" has no source entry (${candidates.join(" or ")})`
        );
      }
    }
    // A target whose layout the derivation cannot describe is reported, not
    // skipped: silently skipping it would reopen the hole this closes.
    expect(unrecognized).toEqual([]);
    expect(missing).toEqual([]);
  });

  it("declares `types` before the implementation in the same branch", () => {
    const late = branches
      .filter((branch): branch is DeclaredBranch => branch.reason === "mismatch")
      .filter((branch) => !branch.typesBeforeImplementation)
      .map(
        (branch) =>
          `${label(branch)}: types="${branch.types}" is declared after "${branch.implementation}"`
      );
    expect(late).toEqual([]);
  });

  it("routes browser consumers to the browser bundle wherever one is built", () => {
    const split = manifests.flatMap((manifest) =>
      browserSplitViolations(manifest.relative, manifest.exports, (candidate) =>
        existsSync(join(root.dir, candidate))
      )
    );
    expect(split).toEqual([]);
  });

  it("declares every condition before the siblings that would shadow it", () => {
    const shadowed = manifests.flatMap((manifest) =>
      orderViolations(manifest.relative, manifest.exports)
    );
    expect(shadowed).toEqual([]);
  });

  it("builds a source entry for every implementation target it declares", () => {
    const unbuilt = manifests
      .filter((manifest) => !GLOB_BUILT_PACKAGES.has(manifest.relative))
      .flatMap((manifest) =>
        buildEntryViolations(manifest.relative, manifest.exports, manifest.scripts)
      );
    expect(unbuilt).toEqual([]);
  });

  it("exempts only packages that really hand their build to a repo-local program", () => {
    // The exemption exists because a glob-driven build has no entry list to
    // read. Tie it to that fact rather than to the package name: if
    // `packages/workglow` goes back to naming its entries in `bun build`
    // commands, no `bun run <file>.ts` remains and this fails, which is the
    // signal to delete the exemption rather than to widen it.
    expect(GLOB_BUILT_PACKAGES.size).toBeGreaterThan(0);
    for (const relative of GLOB_BUILT_PACKAGES) {
      const manifest = manifests.find((entry) => entry.relative === relative);
      expect(manifest, `${relative} is exempt but declares no exports`).toBeDefined();
      const buildScriptText = Object.entries(manifest?.scripts ?? {})
        .filter(([name]) => name.startsWith("build"))
        .map(([, body]) => body)
        .join("\n");
      // `bun run build.ts` / `bun build.ts` — the program itself, not a `.ts`
      // handed to `bun build` as an entry (there the token after `bun` is
      // `build`, which this does not match).
      const programs = [...buildScriptText.matchAll(/\bbun(?:\s+run)?\s+([\w./-]+\.tsx?)(?=\s|$)/g)]
        .map((match) => match[1] as string)
        .filter((program) => existsSync(join(root.dir, dirname(relative), program)));
      expect(programs, `${relative} runs no repo-local build program`).not.toEqual([]);
    }
  });

  it("re-exports rather than duplicates a browser module that has no split", () => {
    // Collected recursively from `src`, not just the entry layer the manifests
    // name: a nominal split reads the same one directory down, and the flat
    // scan could not see it. A `.browser.ts` with no `.ts` beside it (e.g.
    // `packages/tasks/src/codec.browser.ts`) is not a pair and has nothing to
    // be a duplicate of.
    const pairs: EntryPair[] = [];
    const collect = (packageDir: string, relative: string): void => {
      for (const entry of readdirSync(join(root.dir, packageDir, relative), {
        withFileTypes: true,
      })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        if (entry.isDirectory()) {
          collect(packageDir, `${relative}/${entry.name}`);
          continue;
        }
        const stem = /^(.+)\.browser\.(tsx?)$/.exec(entry.name);
        if (stem === null) continue;
        const nodeFile = `${stem[1]}.${stem[2]}`;
        const dir = join(root.dir, packageDir, relative);
        if (!existsSync(join(dir, nodeFile))) continue;
        pairs.push({
          browserPath: `${packageDir}/${relative}/${entry.name}`,
          nodePath: `${packageDir}/${relative}/${nodeFile}`,
          browserText: readFileSync(join(dir, entry.name), "utf8"),
          nodeText: readFileSync(join(dir, nodeFile), "utf8"),
        });
      }
    };
    for (const manifest of manifests) {
      const packageDir = dirname(manifest.relative);
      if (!existsSync(join(root.dir, packageDir, "src"))) continue;
      collect(packageDir, "src");
    }
    // The nine `packages/workglow` shims are pairs, and correctly identical —
    // they are the negative case the rule has to keep passing, so a scan that
    // found nothing would prove nothing.
    expect(pairs.length).toBeGreaterThan(9);
    // And the scan recursed: a regression to the flat `src` listing loses every
    // pair below the entry layer, silently.
    expect(pairs.some((pair) => pair.browserPath.includes("/src/ai/"))).toBe(true);
    expect(duplicateBrowserEntryViolations(pairs)).toEqual([]);
  });

  it("keeps the allowlist free of entries that no longer mismatch", () => {
    const stale = [...ALLOWED_MISMATCHES].filter(
      (entry) => !branches.some((branch) => label(branch) === entry && isViolation(branch))
    );
    expect(stale).toEqual([]);
  });
});

/**
 * A correct manifest is only half of it: TypeScript's condition set is
 * `["import", "types"]` under `moduleResolution: "bundler"`, so `"browser"` is
 * never applied unless the consumer names it in `customConditions`. Without that
 * line a browser project bundles `dist/browser.js` while `tsc` type-checks it
 * against the node declarations — no error anywhere, and the symbols the browser
 * bundle omits still autocomplete.
 */
/** `tsconfig.json` is JSONC, so its comments have to go before `JSON.parse`. */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    out += char;
  }
  return out;
}

describe("browser consumers opt into the browser condition", () => {
  it("examples/web sets customConditions", () => {
    // examples/web is the repo's only browser-bundled TypeScript project, and it
    // imports packages that carry `browser` conditions (`@workglow/util`,
    // `@workglow/indexeddb/storage`, `@workglow/tf-mediapipe/ai`). If that project
    // is renamed or moved, repoint this path at its replacement rather than
    // deleting the check.
    const root = workspaceRoot();
    const tsconfig = JSON.parse(
      stripJsonComments(readFileSync(join(root.dir, "examples/web/tsconfig.json"), "utf8"))
    ) as { compilerOptions?: { customConditions?: readonly string[] } };
    expect(tsconfig.compilerOptions?.customConditions).toContain("browser");
  });
});

/**
 * No manifest violates these rules today, so the code paths that catch them would
 * ship untested. These fixtures exercise them directly.
 */
describe("exports map violation detection", () => {
  it("catches a string-shorthand branch that declares no types", () => {
    expect(
      findViolations("fixture/package.json", {
        ".": {
          browser: "./dist/ai.browser.js",
          types: "./dist/ai.node.d.ts",
          import: "./dist/ai.node.js",
        },
      })
    ).toEqual([
      'fixture/package.json exports["."] [browser]: implementation "./dist/ai.browser.js" ' +
        'declares no types (expected types="./dist/ai.browser.d.ts")',
    ]);
  });

  it("catches an object branch with an implementation but no types", () => {
    expect(
      findViolations("fixture/package.json", {
        ".": {
          browser: { import: "./dist/ai.browser.js" },
          types: "./dist/ai.node.d.ts",
          import: "./dist/ai.node.js",
        },
      })
    ).toEqual([
      'fixture/package.json exports["."] [browser > import]: implementation ' +
        '"./dist/ai.browser.js" declares no types (expected types="./dist/ai.browser.d.ts")',
    ]);
  });

  /**
   * A flat dual-package object. `IMPLEMENTATION_KEYS.find(...)` stopped at
   * `import`, so `require`'s `.cjs` was never paired against anything and its
   * `.d.ts` mismatch went unreported. The nested `require: {types, default}`
   * form the fixtures below use is what hid this.
   */
  it("checks every implementation key in a flat dual-package branch", () => {
    expect(
      findViolations("fixture/package.json", {
        ".": {
          types: "./dist/a.d.ts",
          import: "./dist/a.js",
          require: "./dist/a.cjs",
        },
      })
    ).toEqual([
      'fixture/package.json exports["."] [(default) > require]: types="./dist/a.d.ts" but ' +
        'implementation is "./dist/a.cjs" (expected types="./dist/a.d.cts")',
    ]);
  });

  it("does not turn extra agreeing implementation keys into noise", () => {
    expect(
      findViolations("fixture/package.json", {
        ".": {
          types: "./dist/a.d.ts",
          import: "./dist/a.js",
          default: "./dist/a.js",
        },
      })
    ).toEqual([]);
  });

  it("accepts a `.cjs`/`.mjs` implementation declared by its own extension", () => {
    expect(
      findViolations("fixture/package.json", {
        ".": {
          require: { types: "./dist/ai.d.cts", default: "./dist/ai.cjs" },
          types: "./dist/ai.d.mts",
          import: "./dist/ai.mjs",
        },
      })
    ).toEqual([]);
  });

  it("rejects a `.cjs` implementation declared by a `.d.ts`", () => {
    expect(
      findViolations("fixture/package.json", {
        ".": {
          require: { types: "./dist/ai.d.ts", default: "./dist/ai.cjs" },
          types: "./dist/ai.d.mts",
          import: "./dist/ai.mjs",
        },
      })
    ).toEqual([
      'fixture/package.json exports["."] [require > default]: types="./dist/ai.d.ts" but ' +
        'implementation is "./dist/ai.cjs" (expected types="./dist/ai.d.cts")',
    ]);
  });

  it("ignores a non-module string value such as the package manifest itself", () => {
    expect(findViolations("fixture/package.json", { "./package.json": "./package.json" })).toEqual(
      []
    );
  });

  /**
   * Ordering hazards. Each shape is internally well formed — every `types`
   * names the right target beside the right implementation — so the pairing
   * rule and the `typesBeforeImplementation` flag both pass them, which is the
   * whole reason the order check has to exist separately.
   */
  describe("condition ordering", () => {
    const outerTypesFirst = {
      ".": {
        types: "./dist/node.d.ts",
        browser: { types: "./dist/browser.d.ts", import: "./dist/browser.js" },
        import: "./dist/node.js",
      },
    };

    it("reports a nested condition shadowed by an outer `types`", () => {
      // Documenting WHY a second check is needed: the pairing rule is silent
      // here, so without this the dead `browser` branch ships unnoticed.
      expect(findViolations("fixture/package.json", outerTypesFirst)).toEqual([]);

      expect(orderViolations("fixture/package.json", outerTypesFirst)).toEqual([
        'fixture/package.json exports["."] [(default)]: condition "browser" is declared after ' +
          '"types", so TypeScript resolves "types" first and "browser" is never reached',
      ]);
    });

    it("reports a nested condition shadowed by an implementation key", () => {
      const implementationFirst = {
        ".": {
          import: "./dist/node.js",
          browser: { types: "./dist/browser.d.ts", import: "./dist/browser.js" },
        },
      };
      expect(orderViolations("fixture/package.json", implementationFirst)).toEqual([
        'fixture/package.json exports["."] [(default)]: condition "browser" is declared after ' +
          '"import", so resolution stops there and "browser" is never reached',
      ]);
    });

    // Guards against an "objects only" implementation: a string shorthand is
    // just as dead, and this repo writes that form.
    it("reports a string-shorthand condition declared after `types`", () => {
      const shorthandLate = {
        ".": {
          types: "./dist/node.d.ts",
          import: "./dist/node.js",
          browser: "./dist/browser.js",
        },
      };
      expect(orderViolations("fixture/package.json", shorthandLate)).toEqual([
        'fixture/package.json exports["."] [(default)]: condition "browser" is declared after ' +
          '"types", so TypeScript resolves "types" first and "browser" is never reached',
        'fixture/package.json exports["."] [(default)]: condition "browser" is declared after ' +
          '"import", so resolution stops there and "browser" is never reached',
      ]);
    });

    it("accepts a condition declared before both", () => {
      expect(
        orderViolations("fixture/package.json", {
          ".": {
            browser: { types: "./dist/browser.d.ts", import: "./dist/browser.js" },
            types: "./dist/node.d.ts",
            import: "./dist/node.js",
          },
        })
      ).toEqual([]);
    });
  });

  /**
   * The browser/node split. The probe is injected, so each fixture states both
   * the manifest shape AND whether the browser source entry exists — the pair
   * this rule is a function of.
   */
  describe("browser split", () => {
    const always = (): boolean => true;
    const never = (): boolean => false;

    /** `providers/chrome-ai` verbatim: `browser` duplicates the default branch. */
    const duplicatedBrowserBlock = {
      "./ai": {
        browser: { types: "./dist/ai.d.ts", import: "./dist/ai.js" },
        types: "./dist/ai.d.ts",
        import: "./dist/ai.js",
      },
    };

    it("reports a browser condition that names the node bundle", () => {
      // The go-red proof: every other check in this file passes this manifest.
      expect(findViolations("providers/chrome-ai/package.json", duplicatedBrowserBlock)).toEqual(
        []
      );
      expect(orderViolations("providers/chrome-ai/package.json", duplicatedBrowserBlock)).toEqual(
        []
      );

      expect(
        browserSplitViolations("providers/chrome-ai/package.json", duplicatedBrowserBlock, always)
      ).toEqual([
        'providers/chrome-ai/package.json exports["./ai"] [browser]: implementation ' +
          '"./dist/ai.js" is not the browser bundle, but providers/chrome-ai/src/ai.browser.ts ' +
          'exists (expected "./dist/ai.browser.js")',
      ]);
    });

    it("says nothing about that same shape while no browser source entry exists", () => {
      // Today's tree. chrome-ai and tf-mediapipe are browser-only packages with
      // one entry each, so the duplicate is honest and must not be repointed at
      // a bundle nothing builds.
      expect(
        browserSplitViolations("providers/chrome-ai/package.json", duplicatedBrowserBlock, never)
      ).toEqual([]);
    });

    it("accepts a provider that splits its browser entry properly", () => {
      expect(
        browserSplitViolations(
          "providers/deepseek/package.json",
          {
            "./ai": {
              browser: { types: "./dist/ai.browser.d.ts", import: "./dist/ai.browser.js" },
              types: "./dist/ai.d.ts",
              import: "./dist/ai.js",
            },
          },
          always
        )
      ).toEqual([]);
    });

    it("reports a built browser entry that no condition routes to", () => {
      expect(
        browserSplitViolations(
          "providers/deepseek/package.json",
          { "./ai": { types: "./dist/ai.d.ts", import: "./dist/ai.js" } },
          always
        )
      ).toEqual([
        'providers/deepseek/package.json exports["./ai"]: providers/deepseek/src/ai.browser.ts ' +
          'exists but no "browser" condition is declared, so browser consumers resolve the node ' +
          'bundle "./dist/ai.js" (expected "./dist/ai.browser.js")',
      ]);
    });

    /**
     * `providers/openai` with its browser `"import"` deleted. The block still
     * declares `types`, so `tsc` under `customConditions: ["browser"]` matches
     * `browser > types` and type-checks against the browser declarations, while
     * Vite/webpack enter the same block, recognize no key in it, and fall
     * through to the outer `"import"` — bundling the NODE build. Browser typed
     * as node, which is the inversion this whole file exists to prevent.
     */
    const browserTypesOnly = {
      "./ai": {
        browser: { types: "./dist/ai.browser.d.ts" },
        types: "./dist/ai.d.ts",
        import: "./dist/ai.js",
      },
    };

    it("reports a browser condition that declares types but no implementation", () => {
      // The go-red proof: `collectBranches` pushes no branch at all for a
      // `browser` block with no string-valued implementation key, so every
      // other rule in this file is silent on this manifest.
      expect(findViolations("providers/openai/package.json", browserTypesOnly)).toEqual([]);
      expect(orderViolations("providers/openai/package.json", browserTypesOnly)).toEqual([]);

      expect(
        browserSplitViolations("providers/openai/package.json", browserTypesOnly, always)
      ).toEqual([
        'providers/openai/package.json exports["./ai"] [browser]: the "browser" condition ' +
          "declares no implementation, so a browser bundler enters it, matches nothing, and " +
          'falls through to the node target "./dist/ai.js"',
      ]);
    });

    it("reports it for the packages/* layout too, where no browser source entry exists", () => {
      // Decided BEFORE the source-entry probe on purpose. `packages/*` splits
      // browser and node as two peer entries, so the probe for
      // `src/node.browser.ts` finds nothing and the rest of this rule never
      // runs — an empty `browser` block there is the same bug and would
      // otherwise go unreported for every package in the repo.
      expect(
        browserSplitViolations(
          "packages/storage/package.json",
          {
            ".": {
              browser: { types: "./dist/browser.d.ts" },
              types: "./dist/node.d.ts",
              import: "./dist/node.js",
            },
          },
          never
        )
      ).toEqual([
        'packages/storage/package.json exports["."] [browser]: the "browser" condition declares ' +
          "no implementation, so a browser bundler enters it, matches nothing, and falls " +
          'through to the node target "./dist/node.js"',
      ]);
    });

    it("says nothing about a browser block that does declare its implementation", () => {
      expect(
        browserSplitViolations(
          "packages/storage/package.json",
          {
            ".": {
              browser: { types: "./dist/browser.d.ts", import: "./dist/browser.js" },
              types: "./dist/node.d.ts",
              import: "./dist/node.js",
            },
          },
          never
        )
      ).toEqual([]);
    });

    /**
     * `{ import: { browser: …, default: … } }`. `nodeImportTarget` recurses
     * into `import` and resolves the node target, so the subpath IS checked —
     * but the browser block was looked up flatly on `value`, found nothing, and
     * every rule keyed on it behaved as though no `browser` condition existed.
     */
    it("finds a browser block nested inside another condition", () => {
      expect(
        browserSplitViolations(
          "providers/openai/package.json",
          {
            "./ai": {
              import: {
                browser: { types: "./dist/ai.browser.d.ts" },
                types: "./dist/ai.d.ts",
                default: "./dist/ai.js",
              },
            },
          },
          always
        )
      ).toEqual([
        'providers/openai/package.json exports["./ai"] [browser]: the "browser" condition ' +
          "declares no implementation, so a browser bundler enters it, matches nothing, and " +
          'falls through to the node target "./dist/ai.js"',
      ]);
    });

    it("leaves the packages/* browser/node layout alone", () => {
      // Stem `node`, so the probe asks for `src/node.browser.ts` and finds
      // nothing — the split here is expressed as two peer entries, not a
      // `.browser` suffix, and must not be reported as missing one.
      expect(
        browserSplitViolations(
          "packages/storage/package.json",
          {
            ".": {
              browser: { types: "./dist/browser.d.ts", import: "./dist/browser.js" },
              types: "./dist/node.d.ts",
              import: "./dist/node.js",
            },
          },
          never
        )
      ).toEqual([]);
    });
  });

  /**
   * A nested implementation object shadows exactly like a string one when it
   * always resolves, and not at all when it does not.
   */
  describe("object-valued implementation keys as shadowers", () => {
    it("reports a condition hidden behind a nested `import` that always resolves", () => {
      expect(
        orderViolations("fixture/package.json", {
          ".": {
            import: { types: "./dist/node.d.ts", default: "./dist/node.js" },
            browser: { types: "./dist/browser.d.ts", import: "./dist/browser.js" },
          },
        })
      ).toEqual([
        'fixture/package.json exports["."] [(default)]: condition "browser" is declared after ' +
          '"import", so resolution stops there and "browser" is never reached',
      ]);
    });

    it("does not treat a nested object with no unconditional target as a shadower", () => {
      // `{ import: { node: … } }` resolves to nothing off Node, so a runtime
      // falls through to `browser` exactly as written.
      expect(
        orderViolations("fixture/package.json", {
          ".": {
            import: { node: "./dist/node.js" },
            browser: { types: "./dist/browser.d.ts", import: "./dist/browser.js" },
          },
        })
      ).toEqual([]);
    });
  });

  /**
   * The `.js` half. Every fixture states the manifest AND the build scripts,
   * because the rule is a function of the pair.
   */
  describe("build entries", () => {
    const openaiExports = {
      "./ai": {
        browser: { types: "./dist/ai.browser.d.ts", import: "./dist/ai.browser.js" },
        types: "./dist/ai.d.ts",
        import: "./dist/ai.js",
      },
    };

    it("reports a browser bundle no build script emits", () => {
      // The go-red proof: the manifest is internally perfect and the source
      // entry exists, so pairing, ordering and the browser split all pass —
      // `build-browser` simply never got the new entry appended.
      expect(findViolations("providers/openai/package.json", openaiExports)).toEqual([]);
      expect(orderViolations("providers/openai/package.json", openaiExports)).toEqual([]);

      expect(
        buildEntryViolations("providers/openai/package.json", openaiExports, {
          "build-code": "bun build --packages=external --outdir ./dist ./src/ai.ts",
          "build-types": "tsgo",
        })
      ).toEqual([
        'providers/openai/package.json exports["./ai"]: "./dist/ai.browser.js" is declared but ' +
          "no build* script names its source entry (expected src/ai.browser.ts among the " +
          "entries passed to a build command)",
      ]);
    });

    it("accepts both entries once each build script names one", () => {
      expect(
        buildEntryViolations("providers/openai/package.json", openaiExports, {
          "build-code": "bun build --packages=external --outdir ./dist ./src/ai.ts",
          "build-browser": "bun build --target=browser --outdir ./dist ./src/ai.browser.ts",
          "build-types": "tsgo",
        })
      ).toEqual([]);
    });

    it("does not let a `.browser` entry satisfy the plain stem", () => {
      // Whole-token matching. A substring test finds `src/ai` inside
      // `./src/ai.browser.ts` and passes a package that builds only its
      // browser bundle while publishing the node one.
      expect(
        buildEntryViolations("providers/openai/package.json", openaiExports, {
          "build-browser": "bun build --target=browser --outdir ./dist ./src/ai.browser.ts",
        })
      ).toEqual([
        'providers/openai/package.json exports["./ai"]: "./dist/ai.js" is declared but no ' +
          "build* script names its source entry (expected src/ai.ts among the entries passed " +
          "to a build command)",
      ]);
    });

    it("matches a nested stem produced by a nested --outdir", () => {
      // `providers/duckdb` verbatim: the target is `./dist/storage/browser.js`
      // because `--outdir ./dist/storage` moves the output, while the entry is
      // still written `./src/storage/browser.ts`.
      expect(
        buildEntryViolations(
          "providers/duckdb/package.json",
          {
            "./storage": {
              browser: {
                types: "./dist/storage/browser.d.ts",
                import: "./dist/storage/browser.js",
              },
              types: "./dist/storage/node.d.ts",
              import: "./dist/storage/node.js",
            },
          },
          {
            "build-storage-browser":
              "bun build --target=browser --outdir ./dist/storage ./src/storage/browser.ts",
            "build-storage-node-bun":
              "bun build --target=node --outdir ./dist/storage ./src/storage/node.ts",
          }
        )
      ).toEqual([]);
    });

    it("ignores non-build scripts", () => {
      // `test`/`lint`/`watch` can mention a source path for unrelated reasons;
      // only a `build*` script emits anything.
      expect(
        buildEntryViolations(
          "p/package.json",
          { ".": { types: "./dist/node.d.ts", import: "./dist/node.js" } },
          { test: "vitest run ./src/node.ts", "build-types": "tsgo" }
        )
      ).toEqual([
        'p/package.json exports["."]: "./dist/node.js" is declared but no build* script names ' +
          "its source entry (expected src/node.ts among the entries passed to a build command)",
      ]);
    });

    it("reports an unrecognized layout rather than skipping it", () => {
      expect(
        buildEntryViolations("p/package.json", { ".": "./lib/node.js" }, { "build-js": "tsc" })
      ).toEqual([
        'p/package.json exports["."]: "./lib/node.js" is not ./dist/<stem>.<ext>, so no source ' +
          "entry is derivable",
      ]);
    });

    it("says nothing about a `types`-only entry", () => {
      // Declarations are emitted from the whole `src` tree, so they are the
      // half this rule deliberately does not speak to.
      expect(
        buildEntryViolations("p/package.json", { "./types": { types: "./dist/x.d.ts" } }, {})
      ).toEqual([]);
    });
  });

  /**
   * The duplicate-entry rule. No pair in the tree violates it after
   * `providers/llamacpp-server` and `providers/stable-diffusion-server` were
   * collapsed onto `export * from "./ai"`, so both branches need fixtures.
   */
  describe("duplicate browser entries", () => {
    const license =
      "/**\n * @license\n * Copyright 2026 Steven Roussey <sroussey@gmail.com>\n" +
      " * SPDX-License-Identifier: Apache-2.0\n */\n\n// organize-imports-ignore\n\n";

    it("reports a browser entry that duplicates the node entry through a relative specifier", () => {
      // `providers/llamacpp-server` as it stood: two files, one module graph.
      // Nothing substitutes `./ai/index.browser` for `./ai/index` on a relative
      // specifier, so `dist/ai.browser.d.ts` and `dist/ai.d.ts` describe the
      // same exports and stay equal only by hand.
      expect(
        duplicateBrowserEntryViolations([
          {
            browserPath: "providers/llamacpp-server/src/ai.browser.ts",
            nodePath: "providers/llamacpp-server/src/ai.ts",
            browserText: `${license}export * from "./ai/index";\n`,
            nodeText: `${license}export * from "./ai/index";\n`,
          },
        ])
      ).toEqual([
        "providers/llamacpp-server/src/ai.browser.ts is identical to " +
          'providers/llamacpp-server/src/ai.ts and names only relative specifiers ("./ai/index"), ' +
          "so both entries resolve the same module graph and the declaration split is nominal — " +
          "re-export the node entry from it instead of duplicating it",
      ]);
    });

    it("says nothing about identical shims that re-export a bare specifier", () => {
      // The `packages/workglow` shape, and the reason this rule tests the
      // SPECIFIERS rather than just the text. A bare specifier is re-resolved
      // under the consumer's own conditions at every hop, so these two files
      // land on `@workglow/openai`'s browser and node bundles respectively —
      // the split happens one layer down, in that package's exports map. Their
      // being byte-identical is the mechanism, not a defect: collapsing the
      // browser shim onto `export * from "./openai"` would resolve the bare
      // specifier once, under the shim's own condition, and destroy the split.
      expect(
        duplicateBrowserEntryViolations([
          {
            browserPath: "packages/workglow/src/openai.browser.ts",
            nodePath: "packages/workglow/src/openai.ts",
            browserText: `${license}export * from "@workglow/openai/ai";\n`,
            nodeText: `${license}export * from "@workglow/openai/ai";\n`,
          },
        ])
      ).toEqual([]);
    });

    it("says nothing about a browser entry with a genuinely different graph", () => {
      // `providers/deepseek`: the browser entry names its own barrel, so the
      // two declarations describe different modules and cannot drift together.
      expect(
        duplicateBrowserEntryViolations([
          {
            browserPath: "providers/deepseek/src/ai.browser.ts",
            nodePath: "providers/deepseek/src/ai.ts",
            browserText: `${license}export * from "./ai/index.browser";\n`,
            nodeText: `${license}export * from "./ai/index";\n`,
          },
        ])
      ).toEqual([]);
    });

    it("ignores the license header and comments when comparing", () => {
      // A differing copyright year, or prose added above the export, does not
      // make two entries different modules — and must not be a way to silence
      // the rule.
      expect(
        duplicateBrowserEntryViolations([
          {
            browserPath: "p/src/ai.browser.ts",
            nodePath: "p/src/ai.ts",
            browserText: `${license}// browser build\nexport * from "./ai/index";\n`,
            nodeText:
              '/**\n * @license\n * Copyright 2025 Someone\n */\n\nexport * from "./ai/index";\n',
          },
        ])
      ).toEqual([
        "p/src/ai.browser.ts is identical to p/src/ai.ts and names only relative specifiers " +
          '("./ai/index"), so both entries resolve the same module graph and the declaration ' +
          "split is nominal — re-export the node entry from it instead of duplicating it",
      ]);
    });
  });

  it("derives a source entry from a dist target", () => {
    expect(sourceCandidates("providers/openai/package.json", "./dist/ai.browser.d.ts")).toEqual([
      "providers/openai/src/ai.browser.ts",
      "providers/openai/src/ai.browser.tsx",
    ]);
    // A nested stem keeps its directory, so `./dist/storage/bun.js` is built
    // from `src/storage/bun.ts`, not from a flattened `src/bun.ts`.
    expect(sourceCandidates("providers/sqlite/package.json", "./dist/storage/bun.js")).toEqual([
      "providers/sqlite/src/storage/bun.ts",
      "providers/sqlite/src/storage/bun.tsx",
    ]);
    // The declaration extension is part of the suffix, so `.d.cts` strips whole
    // rather than leaving a `ai.d` stem.
    expect(sourceCandidates("p/package.json", "./dist/ai.d.cts")).toEqual([
      "p/src/ai.ts",
      "p/src/ai.tsx",
    ]);
  });

  it("reports a target outside ./dist as underivable rather than skipping it", () => {
    expect(sourceCandidates("p/package.json", "./lib/ai.js")).toBeUndefined();
  });
});
