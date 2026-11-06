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
import { assertSafeRegexPattern, compileSafeRegex, escapeRegExp } from "../util/regexSafety";
import { linesFromText } from "../util/textLines";
import { fetchUrlEntitlementsFor, FetchUrlTask } from "./FetchUrlTask";

export { linesFromText };

const inputSchema = {
  type: "object",
  properties: {
    url: {
      type: "string",
      title: "URL",
      description:
        "URL to search (http://, https://). The Node/Electron build additionally accepts a `file://` URL or an absolute filesystem path, subject to the `filesystem:read` entitlement and any configured `roots`.",
      format: "uri",
    },
    pattern: {
      type: "string",
      title: "Pattern",
      description: "Regular expression, or a literal string when fixedString is set",
    },
    ignoreCase: {
      type: "boolean",
      title: "Ignore Case",
      description: "Case-insensitive matching (-i)",
    },
    fixedString: {
      type: "boolean",
      title: "Fixed String",
      description: "Treat pattern as a literal string (-F)",
    },
    invertMatch: {
      type: "boolean",
      title: "Invert Match",
      description: "Select lines that do not match (-v)",
    },
    onlyMatching: {
      type: "boolean",
      title: "Only Matching",
      description: "Emit the matched substrings instead of whole lines, one per match (-o)",
    },
    afterContext: {
      type: "integer",
      title: "After Context",
      description: "Lines after each match (-A)",
      minimum: 0,
    },
    beforeContext: {
      type: "integer",
      title: "Before Context",
      description: "Lines before each match (-B)",
      minimum: 0,
    },
    context: {
      type: "integer",
      title: "Context",
      description: "Lines before and after each match (-C)",
      minimum: 0,
    },
    maxMatches: {
      type: "integer",
      title: "Max Matches",
      description: "Stop after this many matching lines (-m)",
      minimum: 1,
    },
    existsOnly: {
      type: "boolean",
      title: "Exists Only",
      description: "Return only whether a match exists (-q-like behavior)",
    },
    countOnly: {
      type: "boolean",
      title: "Count Only",
      description: "Return only the number of matching lines (-c-like behavior)",
    },
    maxOutputLines: {
      type: "integer",
      title: "Max Output Lines",
      description:
        "Maximum number of output lines, including context. Defaults to 10000; set this to override.",
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
  required: ["url", "pattern"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const grepLineSchema = {
  type: "object",
  properties: {
    line: { type: "integer", title: "Line", description: "1-based line number" },
    text: { type: "string", title: "Text", description: "Line contents without the terminator" },
    match: {
      type: "boolean",
      title: "Match",
      description: "Whether this line matched the pattern",
    },
  },
  required: ["line", "text", "match"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

const outputSchema = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      title: "Groups",
      description: "Contiguous match groups, including context lines",
      items: {
        type: "object",
        properties: {
          startLine: { type: "integer", title: "Start Line" },
          endLine: { type: "integer", title: "End Line" },
          lines: {
            type: "array",
            items: grepLineSchema,
          },
        },
        required: ["startLine", "endLine", "lines"],
        additionalProperties: false,
      },
    },
    matchCount: {
      type: "integer",
      title: "Match Count",
      description:
        "Number of matching lines. With `existsOnly` the scan stops at the first match, so this is 1 rather than a full count.",
    },
    exists: {
      type: "boolean",
      title: "Exists",
      description: "Whether any line matched",
    },
    truncated: {
      type: "boolean",
      title: "Truncated",
      description: "Search stopped before EOF because of an output or search limit",
    },
  },
  required: ["groups", "matchCount", "exists", "truncated"],
  additionalProperties: false,
} as const satisfies DataPortSchema;

export type FileGrepTaskInput = FromSchema<typeof inputSchema>;
export type FileGrepTaskOutput = FromSchema<typeof outputSchema>;

interface GrepLine {
  line: number;
  text: string;
  match: boolean;
}

interface GrepGroup {
  startLine: number;
  endLine: number;
  lines: GrepLine[];
}

export type GrepOptions = Omit<FileGrepTaskInput, "url" | "pattern">;

/**
 * Matches a batch of lines at once. Batching is what makes an interruptible
 * matcher affordable — see `createBoundedRegexMatcher` on the server build,
 * whose per-call cost only amortizes over a batch.
 */
export interface GrepLineMatcher {
  readonly matchBatch: (texts: readonly string[]) => boolean[];
  /**
   * Slices matched substrings out of each line, positionally aligned with
   * `texts`. The server matcher bounds this under the same interruptible
   * budget as {@link matchBatch}; without it, `onlyMatching` falls back to an
   * unbounded `exec` on the calling thread.
   */
  readonly extractBatch?: (texts: readonly string[]) => string[][];
}

interface BufferedLine {
  readonly line: number;
  readonly text: string;
}

function validateOptions(options: GrepOptions): void {
  const integerOptions: Array<[keyof GrepOptions, number | undefined]> = [
    ["afterContext", options.afterContext],
    ["beforeContext", options.beforeContext],
    ["context", options.context],
    ["maxMatches", options.maxMatches],
    ["maxOutputLines", options.maxOutputLines],
    ["maxOutputChars", options.maxOutputChars],
  ];

  for (const [name, value] of integerOptions) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new TaskInvalidInputError(`${String(name)} must be a non-negative integer`);
    }
  }

  if (options.maxMatches === 0) {
    throw new TaskInvalidInputError("maxMatches must be greater than zero when specified");
  }
}

export function createMatcher(pattern: string, options: GrepOptions): GrepLineMatcher {
  if (options.fixedString) {
    if (options.ignoreCase) {
      const needle = pattern.toLowerCase();
      return { matchBatch: (texts) => texts.map((t) => t.toLowerCase().includes(needle)) };
    }
    return { matchBatch: (texts) => texts.map((t) => t.includes(pattern)) };
  }

  const regex = compileSafeRegex(pattern, options.ignoreCase ? "i" : "");
  return { matchBatch: (texts) => texts.map((t) => regex.test(t)) };
}

/**
 * Collects the matched substrings of a line for `onlyMatching`. A literal
 * pattern is compiled rather than searched with `indexOf` so that an
 * ignore-case match can be sliced out of the original text: `toLowerCase()`
 * is not length-preserving for every character, so lowercasing the haystack
 * to find an offset can misalign the slice back in the original.
 */
function createExtractor(pattern: string, options: GrepOptions): (text: string) => string[] {
  const source = options.fixedString ? escapeRegExp(pattern) : pattern;

  if (!options.fixedString) {
    assertSafeRegexPattern(pattern);
  }

  let regex: RegExp;
  try {
    regex = new RegExp(source, options.ignoreCase ? "gi" : "g");
  } catch {
    throw new TaskInvalidInputError(`Invalid regular expression: ${pattern}`);
  }

  return (text) => {
    const matches: string[] = [];

    regex.lastIndex = 0;

    let result: RegExpExecArray | null;
    while ((result = regex.exec(text)) !== null) {
      // grep skips a zero-length match; advancing is also what ends the loop.
      if (result[0].length === 0) {
        regex.lastIndex++;
        continue;
      }
      matches.push(result[0]);
    }

    return matches;
  };
}

/**
 * Scans `lines`, matching in batches of {@link SECURITY_LIMITS.regexMatchBatchLines}.
 *
 * Abort and the overall search deadline are checked once per BATCH, not per
 * line: a single `regex.test` is uninterruptible, so per-line checks bought
 * nothing a hostile pattern could not ignore. The granularity that matters is
 * therefore the batch, and the matcher itself bounds how long one batch may run.
 */
export async function grepLines(
  lines: AsyncIterable<string>,
  pattern: string,
  options: GrepOptions = {},
  signal?: AbortSignal,
  matcher?: GrepLineMatcher | undefined
): Promise<FileGrepTaskOutput> {
  validateOptions(options);

  // Context is inert under onlyMatching: a context line holds no match, so
  // grep prints nothing for it, and carrying a window would only let two
  // matches separated by unprinted lines land in one group.
  const beforeContext = options.onlyMatching ? 0 : (options.context ?? options.beforeContext ?? 0);
  const afterContext = options.onlyMatching ? 0 : (options.context ?? options.afterContext ?? 0);

  const lineMatcher = matcher ?? createMatcher(pattern, options);
  const wantExtract = Boolean(options.onlyMatching && !options.existsOnly && !options.countOnly);
  const extract =
    wantExtract && lineMatcher.extractBatch === undefined
      ? createExtractor(pattern, options)
      : undefined;

  const groups: GrepGroup[] = [];
  const beforeBuffer: BufferedLine[] = [];

  let currentGroup: GrepGroup | undefined;

  let lineNumber = 0;
  let matchCount = 0;
  let exists = false;

  let afterRemaining = 0;
  let maxMatchesReached = false;

  let outputLines = 0;
  let outputChars = 0;

  // Caps apply whether or not the caller stated them: an unbounded default sent
  // the whole document back to whoever asked for one line.
  const maxOutputLines = options.maxOutputLines ?? DEFAULT_LIMITS.grepMaxOutputLines;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_LIMITS.grepMaxOutputChars;

  function canEmit(text: string): boolean {
    if (outputLines >= maxOutputLines) {
      return false;
    }

    if (outputChars + text.length + 1 > maxOutputChars) {
      return false;
    }

    return true;
  }

  function emitLine(entry: GrepLine): boolean {
    /*
     * Entries are appended in strictly increasing line order, so a line at or
     * below endLine has already been emitted; only the last one can be it.
     * The scan this replaces existed solely to skip replayed beforeBuffer
     * entries, and those always carry match: false, so no flag is lost.
     *
     * Decided BEFORE the output caps, because this branch emits nothing: a
     * line already in the group must not be charged against the caps, nor
     * refused by them — a cap reached by replayed lines would otherwise drop
     * the real matches that follow.
     *
     * Skipped entirely under onlyMatching, where one line legitimately yields
     * several entries and merging them would collapse repeated matches
     * into one.
     */
    if (currentGroup && !options.onlyMatching && entry.line <= currentGroup.endLine) {
      const last = currentGroup.lines[currentGroup.lines.length - 1];
      if (entry.match && last?.line === entry.line) {
        last.match = true;
      }

      return true;
    }

    if (!canEmit(entry.text)) {
      return false;
    }

    if (currentGroup && entry.line <= currentGroup.endLine + 1) {
      currentGroup.lines.push(entry);
      currentGroup.endLine = entry.line;
    } else {
      currentGroup = {
        startLine: entry.line,
        endLine: entry.line,
        lines: [entry],
      };

      groups.push(currentGroup);
    }

    outputLines++;
    outputChars += entry.text.length + 1;

    return true;
  }

  const iterator = lines[Symbol.asyncIterator]();
  const deadline = Date.now() + DEFAULT_LIMITS.grepMaxSearchMs;
  const maxLineChars = DEFAULT_LIMITS.grepMaxLineChars;
  const batch: string[] = [];
  let exhausted = false;

  // `stopped` says the scan ended early; whether that MEANS truncation depends
  // on whether anything was left, which is settled once, below.
  let stopped = false;
  let stopIndex = -1;
  let existsOnlyHit = false;
  let lineCapped = false;
  let sawMoreInput = false;

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
        stopped = true;
        break;
      }

      const flags = lineMatcher.matchBatch(batch);
      const extracted =
        wantExtract && lineMatcher.extractBatch !== undefined
          ? lineMatcher.extractBatch(batch)
          : undefined;

      for (let i = 0; i < batch.length; i++) {
        const text = batch[i]!;

        lineNumber++;

        let matched = flags[i]!;

        if (options.invertMatch) {
          matched = !matched;
        }

        if (matched && !maxMatchesReached) {
          matchCount++;
          exists = true;

          if (options.existsOnly) {
            existsOnlyHit = true;
            stopped = true;
            stopIndex = i;
            break outer;
          }

          if (wantExtract) {
            // An inverted selection reaches here on a line the pattern did NOT
            // match, so the extractor finds nothing and emits nothing — which is
            // exactly what `grep -v -o` prints.
            const matches = extracted !== undefined ? (extracted[i] ?? []) : extract!(text);
            for (const match of matches) {
              if (!emitLine({ line: lineNumber, text: match, match: true })) {
                return {
                  groups,
                  matchCount,
                  exists,
                  truncated: true,
                };
              }
            }
          } else if (!options.countOnly) {
            for (const previous of beforeBuffer) {
              if (
                !emitLine({
                  line: previous.line,
                  text: previous.text,
                  match: false,
                })
              ) {
                stopped = true;
                stopIndex = i - 1;
                break outer;
              }
            }

            if (
              !emitLine({
                line: lineNumber,
                text,
                match: true,
              })
            ) {
              stopped = true;
              stopIndex = i - 1;
              break outer;
            }
          }

          afterRemaining = afterContext;

          if (options.maxMatches !== undefined && matchCount >= options.maxMatches) {
            maxMatchesReached = true;

            if (afterContext === 0) {
              stopped = true;
              stopIndex = i;
              break outer;
            }
          }
        } else if (!options.countOnly && afterRemaining > 0) {
          if (
            !emitLine({
              line: lineNumber,
              text,
              // `maxMatchesReached` governs whether a match COUNTS toward the
              // budget, not whether the line IS a match.
              match: matched,
            })
          ) {
            stopped = true;
            stopIndex = i - 1;
            break outer;
          }

          afterRemaining--;
        }

        beforeBuffer.push({
          line: lineNumber,
          text,
        });

        if (beforeBuffer.length > beforeContext) {
          beforeBuffer.shift();
        }

        if (maxMatchesReached) {
          if (afterRemaining === 0) {
            stopped = true;
            stopIndex = i;
            break outer;
          }

          continue;
        }
      }
    }

    /*
     * Truncation is exact because the loop drives the iterator itself: it is
     * only truncation if something was actually left, either in the current
     * batch or in the source. That costs one extra element from the source on
     * an early stop.
     *
     * `stopIndex` is the last line fully accounted for. An output cap rejects
     * the line it stopped on, so those sites record `i - 1` and that line
     * counts as remaining; a match budget consumed its line, so those record
     * `i`.
     */
    if (stopped) {
      sawMoreInput = stopIndex + 1 < batch.length ? true : (await iterator.next()).done !== true;
    }
  } finally {
    await iterator.return?.();
  }

  const truncated = lineCapped || (stopped && sawMoreInput);

  if (existsOnlyHit) {
    return { groups: [], matchCount: 1, exists: true, truncated };
  }

  return {
    groups: options.countOnly ? [] : groups,
    matchCount,
    exists,
    truncated,
  };
}

/**
 * Task for grepping documents fetched over http(s).
 *
 * This build handles http and https only: the fetch routes through
 * `FetchUrlTask` -> `safeFetch` -> `classifyUrl`, which rejects every other
 * scheme. `file://` URLs and bare filesystem paths are handled only by the
 * server build (`FileGrepTask.server`), which requires the `filesystem:read`
 * entitlement.
 */
export class FileGrepTask<Config extends TaskConfig = TaskConfig> extends Task<
  FileGrepTaskInput,
  FileGrepTaskOutput,
  Config
> {
  public static override type = "FileGrepTask";
  public static override category = "Document";
  public static override title = "File Grep";
  public static override description = "Search a file for matching lines (grep)";
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
   * Seam for the matcher the scan runs. The server build overrides it to bound
   * regex matching with an interruptible time budget; there is no `vm` in a
   * browser, so a hostile pattern there still blocks that tab (a tab — not the
   * process hosting a local API).
   */
  protected createLineMatcher(pattern: string, options: GrepOptions): GrepLineMatcher {
    return createMatcher(pattern, options);
  }

  override async execute(
    input: FileGrepTaskInput,
    context: IExecuteContext
  ): Promise<FileGrepTaskOutput> {
    const { url, pattern, ...options } = input;

    if (context.signal.aborted) {
      throw new TaskAbortedError("Task aborted");
    }

    // Compiled before the fetch so a rejected pattern costs no network call.
    const matcher = this.createLineMatcher(pattern, options);

    await context.updateProgress(0, "Fetching file");

    const fetchTask = context.own(new FetchUrlTask({ queue: false }));
    const response = await fetchTask.run({
      url,
      response_type: "text",
    });

    if (context.signal.aborted) {
      throw new TaskAbortedError("Task aborted");
    }
    await context.updateProgress(60, "Searching file");

    const result = await grepLines(
      linesFromText(response.text ?? ""),
      pattern,
      options,
      context.signal,
      matcher
    );

    if (context.signal.aborted) {
      throw new TaskAbortedError("Task aborted");
    }
    await context.updateProgress(100, "Search complete");

    return result;
  }
}

/**
 * Config for both builds. `roots` is declared here rather than beside the
 * server subclass because a `declare module` augmentation must state one type
 * across every file that contributes it, and both files augment `Workflow`
 * with `fileGrep`. Declaring it only on the server made the two disagree
 * (TS2717); declaring `TaskConfig` in both would keep them agreeing but drop
 * `roots` from `workflow.fileGrep(...)`, which is the API most callers use.
 */
export interface FileGrepTaskConfig extends TaskConfig {
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

export const fileGrep = (input: FileGrepTaskInput, config?: FileGrepTaskConfig) => {
  return new FileGrepTask(config).run(input);
};

declare module "@workglow/task-graph" {
  interface Workflow {
    fileGrep: CreateWorkflow<FileGrepTaskInput, FileGrepTaskOutput, FileGrepTaskConfig>;
  }
}

Workflow.prototype.fileGrep = CreateWorkflow(FileGrepTask);
