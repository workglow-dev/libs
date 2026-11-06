/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CachePolicy,
  IExecuteContext,
  TaskConfig,
  TaskEntitlements,
} from "@workglow/task-graph";
import {
  CreateWorkflow,
  Task,
  TaskAbortedError,
  TaskInvalidInputError,
  Workflow,
} from "@workglow/task-graph";
import { DEFAULT_LIMITS, SECURITY_LIMITS } from "@workglow/util";
import type { DataPortSchema, FromSchema } from "@workglow/util/schema";
import { compileSafeRegex, escapeRegExp } from "../util/regexSafety";
import { linesFromText } from "../util/textLines";
import { fetchUrlEntitlementsFor, FetchUrlTask } from "./FetchUrlTask";

const inputSchema = {
  type: "object",
  properties: {
    url: {
      type: "string",
      title: "URL",
      description:
        "URL to transform (http://, https://). The Node/Electron build additionally accepts a `file://` URL or an absolute filesystem path, subject to the `filesystem:read` entitlement and any configured `roots`.",
      format: "uri",
    },
    pattern: {
      type: "string",
      title: "Pattern",
      description: "Regular expression, or a literal string when fixedString is set",
    },
    replacement: {
      type: "string",
      title: "Replacement",
      description:
        "Text substituted for each match. Supports $1/$& when the pattern is a regular expression; literal when fixedString is set",
    },
    ignoreCase: {
      type: "boolean",
      title: "Ignore Case",
      description: "Case-insensitive matching (s///i)",
    },
    fixedString: {
      type: "boolean",
      title: "Fixed String",
      description: "Treat pattern and replacement as literal strings",
    },
    global: {
      type: "boolean",
      title: "Global",
      description: "Replace every occurrence on a line rather than the first (s///g)",
    },
    maxReplacements: {
      type: "integer",
      title: "Max Replacements",
      description: "Stop substituting after this many replacements; later lines pass through",
      minimum: 1,
    },
    onlyChangedLines: {
      type: "boolean",
      title: "Only Changed Lines",
      description: "Emit only the lines that changed (sed -n 's///p')",
    },
    maxOutputLines: {
      type: "integer",
      title: "Max Output Lines",
      description: "Maximum number of output lines. Defaults to 10000; set this to override.",
      minimum: 0,
    },
    maxOutputChars: {
      type: "integer",
      title: "Max Output Characters",
      description:
        "Maximum number of output characters, including newlines. Defaults to 1000000; set this to override.",
      minimum: 0,
    },
  },
  required: ["url", "pattern", "replacement"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      title: "Text",
      description: "Transformed document",
    },
    replacementCount: {
      type: "integer",
      title: "Replacement Count",
      description: "Number of substitutions performed",
    },
    linesChanged: {
      type: "integer",
      title: "Lines Changed",
      description: "Number of lines with at least one substitution",
    },
    truncated: {
      type: "boolean",
      title: "Truncated",
      description:
        "Output stopped before EOF because an output cap or the search deadline was reached, or an input line was capped",
    },
  },
  required: ["text", "replacementCount", "linesChanged", "truncated"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type FileSedTaskInput = FromSchema<typeof inputSchema>;
export type FileSedTaskOutput = FromSchema<typeof outputSchema>;

export type SedOptions = Omit<FileSedTaskInput, "url" | "pattern" | "replacement">;

/** One batch of substituted lines, positionally aligned with the input. */
export interface SedBatchResult {
  readonly texts: readonly string[];
  readonly counts: readonly number[];
}

/**
 * Substitutes over a batch of lines at once. Batching is what makes an
 * interruptible substituter affordable — see `createBoundedRegexReplacer` on
 * the server build, whose per-call cost only amortizes over a batch.
 *
 * `budget` is how many replacements the whole run may still make, so a global
 * substitution can be cut mid-line and the rest of the document copied verbatim.
 */
export interface SedLineSubstituter {
  readonly substituteBatch: (texts: readonly string[], budget: number) => SedBatchResult;
}

function validateOptions(options: SedOptions): void {
  const integerOptions: Array<[keyof SedOptions, number | undefined]> = [
    ["maxReplacements", options.maxReplacements],
    ["maxOutputLines", options.maxOutputLines],
    ["maxOutputChars", options.maxOutputChars],
  ];

  for (const [name, value] of integerOptions) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new TaskInvalidInputError(`${String(name)} must be a non-negative integer`);
    }
  }

  if (options.maxReplacements === 0) {
    throw new TaskInvalidInputError("maxReplacements must be greater than zero when specified");
  }
}

/** Compiles the substitution pattern, screening it for ReDoS shapes first. */
export function createSedRegex(pattern: string, options: SedOptions): RegExp {
  const flags = `${options.global ? "g" : ""}${options.ignoreCase ? "i" : ""}`;

  if (options.fixedString) {
    if (pattern.length === 0) {
      throw new TaskInvalidInputError("pattern must not be empty when fixedString is set");
    }
    return new RegExp(escapeRegExp(pattern), flags);
  }

  return compileSafeRegex(pattern, flags);
}

/**
 * The expansion `String.replace` would do itself if it were handed a string.
 * A literal replacement must not be re-read for `$1` / `$&` expansion.
 */
export function createSedExpander(
  replacement: string,
  options: SedOptions
): (args: unknown[]) => string {
  return options.fixedString ? () => replacement : (args) => expandReplacement(replacement, args);
}

/** Unbounded substituter; the server build overrides it with a bounded one. */
export function createSubstituter(
  pattern: string,
  replacement: string,
  options: SedOptions
): SedLineSubstituter {
  const regex = createSedRegex(pattern, options);
  const substitute = createSedExpander(replacement, options);

  const substituteLine = (text: string, budget: number): [string, number] => {
    let replacements = 0;

    const result = text.replace(regex, (...args: unknown[]): string => {
      if (replacements >= budget) {
        return args[0] as string;
      }
      replacements++;
      return substitute(args);
    });

    return [result, replacements];
  };

  return {
    substituteBatch: (lines, budget) => {
      const texts: string[] = [];
      const counts: number[] = [];

      let remaining = budget;

      for (const line of lines) {
        if (remaining <= 0) {
          texts.push(line);
          counts.push(0);
          continue;
        }
        const [text, replacements] = substituteLine(line, remaining);
        texts.push(text);
        counts.push(replacements);
        remaining -= replacements;
      }

      return { texts, counts };
    },
  };
}

/**
 * `String.replace` only expands `$n` when handed a string, and a callback is
 * what bounds the substitution count — so the expansion is done here instead.
 */
export function expandReplacement(replacement: string, args: unknown[]): string {
  if (!replacement.includes("$")) {
    return replacement;
  }

  const match = args[0] as string;

  // Trailing args are the offset, the subject, and optionally the named groups.
  const hasNamed = typeof args[args.length - 1] === "object";
  const end = hasNamed ? args.length - 1 : args.length;
  const groups = args.slice(1, end - 2) as Array<string | undefined>;
  const named = hasNamed
    ? (args[args.length - 1] as Record<string, string | undefined>)
    : undefined;

  let out = "";

  // Latched once no '>' remains: the scan index only grows, so a failed search
  // can never succeed later, and re-searching would make this quadratic on a
  // replacement of unterminated `$<`.
  let mayHaveGroupName = true;

  for (let index = 0; index < replacement.length; index++) {
    const char = replacement[index];
    const next = replacement[index + 1];

    if (char !== "$" || next === undefined) {
      out += char;
      continue;
    }

    if (next === "$") {
      out += "$";
      index++;
      continue;
    }

    if (next === "&") {
      out += match;
      index++;
      continue;
    }

    if (next === "<") {
      const close = mayHaveGroupName ? replacement.indexOf(">", index + 2) : -1;
      if (close === -1) {
        mayHaveGroupName = false;
        out += char;
        continue;
      }
      /*
       * With no named groups in the pattern the engine leaves `$<name>`
       * alone — `"abc".replace(/b/, "[$<x>]")` yields `"a[$<x>]c"` — so
       * substituting "" here would silently DELETE the caller's text.
       * Emitting only `$` without advancing past `close` is deliberate: the
       * `<`, the name and the `>` are then copied one character at a time by
       * the loop's literal path, reproducing the run exactly.
       *
       * An UNKNOWN name in a pattern that does have named groups still
       * expands to "", which is what the engine does.
       */
      if (named === undefined) {
        out += char;
        continue;
      }

      out += named[replacement.slice(index + 2, close)] ?? "";
      index = close;
      continue;
    }

    if (next >= "0" && next <= "9") {
      let selector = next;

      // A two-digit reference wins only when that group actually exists.
      const after = replacement[index + 2];
      if (after !== undefined && after >= "0" && after <= "9") {
        if (Number(next + after) <= groups.length) {
          selector = next + after;
        }
      }

      const group = Number(selector);

      if (group < 1 || group > groups.length) {
        out += char;
        continue;
      }

      out += groups[group - 1] ?? "";
      index += selector.length;
      continue;
    }

    out += char;
  }

  return out;
}

/**
 * Substitutes over `lines` in batches of {@link SECURITY_LIMITS.regexMatchBatchLines}.
 *
 * Abort and the overall search deadline are checked once per BATCH, not per
 * line: a single `String.replace` is uninterruptible, so a per-line check
 * bought nothing a hostile pattern could not ignore. The granularity that
 * matters is therefore the batch, and the substituter itself bounds how long
 * one batch may run.
 *
 * The deadline is what stops a run under `onlyChangedLines`, where the output
 * caps are skipped for every unchanged line: a pattern that matches nothing
 * emits nothing, so without it EOF would be the only stopping condition and a
 * huge source would be read to the end.
 */
export async function sedLines(
  lines: AsyncIterable<string>,
  pattern: string,
  replacement: string,
  options: SedOptions = {},
  signal?: AbortSignal,
  substituter?: SedLineSubstituter | undefined
): Promise<FileSedTaskOutput> {
  validateOptions(options);

  const lineSubstituter = substituter ?? createSubstituter(pattern, replacement, options);

  const out: string[] = [];

  let replacementCount = 0;
  let linesChanged = 0;
  let truncated = false;

  let outputLines = 0;
  let outputChars = 0;

  // Caps apply whether or not the caller stated them: an unbounded default
  // returned the whole document to whoever asked for one substitution.
  const maxOutputLines = options.maxOutputLines ?? DEFAULT_LIMITS.grepMaxOutputLines;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_LIMITS.grepMaxOutputChars;

  const iterator = lines[Symbol.asyncIterator]();
  const deadline = Date.now() + DEFAULT_LIMITS.grepMaxSearchMs;
  const maxLineChars = DEFAULT_LIMITS.grepMaxLineChars;
  const batch: string[] = [];
  let exhausted = false;
  let lineCapped = false;

  try {
    outer: while (!exhausted) {
      batch.length = 0;
      while (batch.length < SECURITY_LIMITS.regexMatchBatchLines) {
        const next = await iterator.next();
        if (next.done === true) {
          exhausted = true;
          break;
        }
        // `>=` rather than `>`: conservative by one character, and it lets the
        // server's line splitter signal truncation without a side channel.
        const text = next.value;
        if (text.length >= maxLineChars) {
          lineCapped = true;
          batch.push(text.slice(0, maxLineChars));
        } else {
          batch.push(text);
        }
      }

      if (batch.length === 0) break;

      if (signal?.aborted) {
        throw new TaskAbortedError("Task aborted");
      }
      if (Date.now() > deadline) {
        truncated = true;
        break outer;
      }

      const budget =
        options.maxReplacements === undefined
          ? Number.POSITIVE_INFINITY
          : options.maxReplacements - replacementCount;

      const { texts, counts } = lineSubstituter.substituteBatch(batch, budget);

      for (let i = 0; i < batch.length; i++) {
        const replaced = texts[i]!;
        const replacements = counts[i]!;

        replacementCount += replacements;
        if (replacements > 0) {
          linesChanged++;
        }

        if (options.onlyChangedLines && replacements === 0) {
          continue;
        }

        if (outputLines >= maxOutputLines) {
          truncated = true;
          break outer;
        }

        const chars = replaced.length + 1;

        if (outputChars + chars > maxOutputChars) {
          truncated = true;
          break outer;
        }

        out.push(replaced);
        outputLines++;
        outputChars += chars;
      }
    }
  } finally {
    await iterator.return?.();
  }

  return {
    text: out.length === 0 ? "" : `${out.join("\n")}\n`,
    replacementCount,
    linesChanged,
    // A capped line means the emitted document is missing part of the source,
    // which is what `truncated` is for — an output cap is not the only way to
    // stop short of the whole document.
    truncated: truncated || lineCapped,
  };
}

/**
 * Task for substituting text in documents fetched from URLs.
 * Works in all environments (browser, Node.js, Bun) by using fetch API.
 * `file://` filesystem access is implemented in the server build only; see
 * FileSedTask.server.
 *
 * The source is never modified: the transformed document is returned as output.
 */
export class FileSedTask<Config extends TaskConfig = TaskConfig> extends Task<
  FileSedTaskInput,
  FileSedTaskOutput,
  Config
> {
  public static override type = "FileSedTask";
  public static override category = "Document";
  public static override title = "File Sed";
  public static override description = "Substitute matching text in a file (sed)";
  /**
   * Not cached: the result is the document as it is now, and the cache key is only the
   * url — a file or resource changed between runs would be answered as it was.
   * `cachePolicy` rather than `cacheable = false`: the server variants extend this class,
   * and the resolver honours `cacheable` only where a class declares it itself.
   */
  public static override cachePolicy: CachePolicy = { kind: "none" };
  public static override hasDynamicEntitlements: boolean = true;

  /**
   * The owned `FetchUrlTask` does the network access, but an owned child is
   * created inside `execute()` and so is absent from the graph-start snapshot
   * `computeGraphEntitlements` takes over `graph.getTasks()`. Declaring the
   * fetch's entitlements here is what puts them in front of the enforcer.
   */
  public static override entitlements(): TaskEntitlements {
    return FetchUrlTask.entitlements();
  }

  public override entitlements(): TaskEntitlements {
    return fetchUrlEntitlementsFor(this.runInputData?.url);
  }

  public static override inputSchema(): DataPortSchema {
    return inputSchema as DataPortSchema;
  }

  public static override outputSchema(): DataPortSchema {
    return outputSchema as DataPortSchema;
  }

  /**
   * Seam for the substituter the scan runs. The server build overrides it to
   * bound matching with an interruptible time budget; there is no `vm` in a
   * browser, so a hostile pattern there still blocks that tab (a tab — not the
   * process hosting a local API).
   */
  protected createSubstituter(
    pattern: string,
    replacement: string,
    options: SedOptions
  ): SedLineSubstituter {
    return createSubstituter(pattern, replacement, options);
  }

  override async execute(
    input: FileSedTaskInput,
    context: IExecuteContext
  ): Promise<FileSedTaskOutput> {
    const { url, pattern, replacement, ...options } = input;

    if (context.signal.aborted) {
      throw new TaskAbortedError("Task aborted");
    }

    // Compiled before the fetch so a rejected pattern costs no network call.
    const substituter = this.createSubstituter(pattern, replacement, options);

    await context.updateProgress(0, "Fetching file");

    const fetchTask = context.own(new FetchUrlTask({ queue: false }));
    const response = await fetchTask.run({
      url,
      response_type: "text",
    });

    if (context.signal.aborted) {
      throw new TaskAbortedError("Task aborted");
    }
    await context.updateProgress(60, "Substituting text");

    const result = await sedLines(
      linesFromText(response.text ?? ""),
      pattern,
      replacement,
      options,
      context.signal,
      substituter
    );

    if (context.signal.aborted) {
      throw new TaskAbortedError("Task aborted");
    }
    await context.updateProgress(100, "Substitution complete");

    return result;
  }
}

/**
 * Config for both builds. `roots` is declared here rather than beside the
 * server subclass because a `declare module` augmentation must state one type
 * across every file that contributes it, and both files augment `Workflow`
 * with `fileSed`.
 */
export interface FileSedTaskConfig extends TaskConfig {
  /**
   * Directories a local path must resolve inside, checked after symlinks are
   * resolved. Omitted means `[process.cwd()]`, NOT unrestricted — the
   * `filesystem:read` entitlement is only consulted when the embedder runs
   * with `enforceEntitlements` and a registered enforcer, so it cannot stand
   * in as the default fence. State {@link allowAnyRoot} to opt out.
   *
   * Honored only by the server build — the cross-platform class reaches
   * http(s) through `FetchUrlTask` and touches no filesystem.
   */
  readonly roots?: readonly string[] | undefined;
  /**
   * Read any path the process can open, skipping containment entirely. Only
   * the literal `true` does so, and it is never implied by leaving `roots`
   * unset.
   */
  readonly allowAnyRoot?: boolean | undefined;
}

export const fileSed = (input: FileSedTaskInput, config?: FileSedTaskConfig) => {
  return new FileSedTask(config).run(input);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    fileSed: CreateWorkflow<FileSedTaskInput, FileSedTaskOutput, FileSedTaskConfig>;
  }
}

Workflow.prototype.fileSed = CreateWorkflow(FileSedTask);
