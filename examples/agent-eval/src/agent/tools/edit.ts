/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolDefinition } from "@workglow/ai";
import { ToolCallError } from "@workglow/ai";
import { readFile, writeFile } from "node:fs/promises";
import type { CodingToolContext } from "./context";
import { requireString, resolvePath } from "./context";

export interface TextEdit {
  readonly oldText: string;
  readonly newText: string;
}

interface Range {
  readonly start: number;
  readonly end: number;
  readonly fuzzy: boolean;
}

/**
 * One line as the fuzzy pass compares it: compatibility-normalized, with
 * typographic quotes, dashes and spaces folded to ASCII and trailing
 * whitespace dropped. These are the differences a model introduces when it
 * retypes a line it read, and none of them is a difference the author meant.
 */
export function normalizeLine(line: string): string {
  return line
    .normalize("NFKC")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[  -​  　]/g, " ")
    .trimEnd();
}

function exactRanges(content: string, needle: string): number[] {
  const found: number[] = [];
  let at = content.indexOf(needle);
  while (at !== -1) {
    found.push(at);
    at = content.indexOf(needle, at + 1);
  }
  return found;
}

/** Character offset where each line of `content` starts. */
function lineStarts(lines: readonly string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

/**
 * Whole-line matches of `oldText` once both sides are normalized. Matching
 * whole lines keeps the mapping back to the original text exact: the range is
 * the original lines, whatever the normalization changed inside them.
 */
function fuzzyRanges(content: string, oldText: string): Range[] {
  const trailingNewline = oldText.endsWith("\n");
  const body = trailingNewline ? oldText.slice(0, -1) : oldText;
  const wanted = body.split("\n").map(normalizeLine);
  const lines = content.split("\n");
  const normalized = lines.map(normalizeLine);
  const starts = lineStarts(lines);
  const ranges: Range[] = [];
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    let match = true;
    for (let j = 0; j < wanted.length; j++) {
      if (normalized[i + j] !== wanted[j]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const lastLine = i + wanted.length - 1;
    let end = starts[lastLine]! + lines[lastLine]!.length;
    if (trailingNewline && end < content.length) end += 1;
    ranges.push({ start: starts[i]!, end, fuzzy: true });
  }
  return ranges;
}

/**
 * Where one edit applies in the original text. Exact first, then the fuzzy
 * line match; either way the match must be unique, because guessing which of
 * two identical blocks the model meant is how an edit lands in the wrong place.
 */
function locate(content: string, edit: TextEdit, path: string, index: number): Range {
  const label = `edits[${index}]`;
  if (edit.oldText.length === 0) {
    throw new ToolCallError(`${label}: oldText is empty. Use write to create a file.`);
  }
  const exact = exactRanges(content, edit.oldText);
  if (exact.length === 1) {
    return { start: exact[0]!, end: exact[0]! + edit.oldText.length, fuzzy: false };
  }
  if (exact.length > 1) {
    throw new ToolCallError(
      `${label}: found ${exact.length} occurrences of oldText in ${path}. ` +
        "Include more surrounding lines so it matches exactly one place."
    );
  }
  const fuzzy = fuzzyRanges(content, edit.oldText);
  if (fuzzy.length === 1) return fuzzy[0]!;
  if (fuzzy.length > 1) {
    throw new ToolCallError(
      `${label}: found ${fuzzy.length} places matching oldText in ${path} (ignoring trailing ` +
        "whitespace and typographic quotes). Include more surrounding lines so it matches one."
    );
  }
  throw new ToolCallError(
    `${label}: could not find oldText in ${path}. It must match the file exactly, including ` +
      "indentation. Read the file again to see its current content."
  );
}

export interface EditOutcome {
  readonly content: string;
  /** Applied edits that matched only after normalizing whitespace and quotes. */
  readonly fuzzy: number;
  /** Indices of the edits written. */
  readonly applied: readonly number[];
  /** Indices of edits whose newText equals their oldText: nothing to do. */
  readonly unchanged: readonly number[];
  /** Why each remaining edit was not applied, as `edits[i]: reason`. */
  readonly failures: readonly string[];
}

/**
 * Applies every edit that can be applied, each located against the ORIGINAL
 * text so one edit cannot move another's match, and reports the rest. Failing
 * the whole call for one bad entry costs the model a round resending the good
 * ones; this way it resends only what failed. An edit overlapping one earlier
 * in the list is refused rather than resolved in some order.
 */
export function applyEdits(content: string, edits: readonly TextEdit[], path: string): EditOutcome {
  const unchanged: number[] = [];
  const failures: string[] = [];
  const located: Array<{
    readonly index: number;
    readonly edit: TextEdit;
    readonly range: Range;
  }> = [];
  edits.forEach((edit, index) => {
    if (edit.oldText.length > 0 && edit.oldText === edit.newText) {
      unchanged.push(index);
      return;
    }
    try {
      const range = locate(content, edit, path, index);
      const clash = located.find(
        (other) => range.start < other.range.end && other.range.start < range.end
      );
      if (clash) {
        failures.push(
          `edits[${index}]: overlaps edits[${clash.index}], which was applied. Read the file and ` +
            "resend this change against its current text."
        );
        return;
      }
      located.push({ index, edit, range });
    } catch (error) {
      if (!(error instanceof ToolCallError)) throw error;
      failures.push(error.message);
    }
  });
  let next = content;
  for (const { edit, range } of [...located].sort((a, b) => b.range.start - a.range.start)) {
    next = next.slice(0, range.start) + edit.newText + next.slice(range.end);
  }
  return {
    content: next,
    fuzzy: located.filter((entry) => entry.range.fuzzy).length,
    applied: located.map((entry) => entry.index).sort((a, b) => a - b),
    unchanged,
    failures,
  };
}

/**
 * The edits, as the schema already checked them. A JSON-encoded array or the
 * single `oldText`/`newText` shape models also send never get here: AgentTask
 * validates against the schema before the tool runs, and has no hook to repair
 * arguments first.
 */
function readEdits(input: Record<string, unknown>): TextEdit[] {
  const raw = input.edits;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ToolCallError("edits must be a non-empty array of {oldText, newText}");
  }
  return raw.map((entry, index) => {
    const edit = entry as Record<string, unknown>;
    if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") {
      throw new ToolCallError(`edits[${index}] needs string oldText and newText`);
    }
    return { oldText: edit.oldText, newText: edit.newText };
  });
}

export function createEditTool(context: CodingToolContext): ToolDefinition {
  return {
    name: "edit",
    description:
      "Replace text in an existing file. Each edit's oldText must match exactly one place in " +
      "the file as it was before this call (a match that differs only in trailing whitespace " +
      "or typographic quotes is accepted). Put several disjoint changes to one file in one call. " +
      "Edits that match are applied even when others in the call do not; the result names " +
      "the ones that were not. Keep oldText as short as uniqueness allows.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, absolute or relative to the cwd" },
        edits: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "Text to replace" },
              newText: { type: "string", description: "Replacement text" },
            },
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
    requiresApproval: false,
    execute: async (input) => {
      const path = resolvePath(context, requireString(input, "path"));
      const edits = readEdits(input);
      const original = await readFile(path, "utf8").catch(() => {
        throw new ToolCallError(`File not found: ${path}. Use write to create it.`);
      });
      // Matching runs on LF text; the file keeps its own line endings and BOM.
      const bom = original.startsWith("﻿") ? "﻿" : "";
      const crlf = original.includes("\r\n");
      const lf = (text: string): string => text.replace(/\r\n/g, "\n");
      const body = lf(bom ? original.slice(1) : original);
      const result = applyEdits(
        body,
        edits.map((edit) => ({ oldText: lf(edit.oldText), newText: lf(edit.newText) })),
        path
      );
      if (result.applied.length > 0) {
        const out = bom + (crlf ? result.content.replace(/\n/g, "\r\n") : result.content);
        await writeFile(path, out, "utf8");
      }
      const note = result.fuzzy > 0 ? ` (${result.fuzzy} matched ignoring whitespace/quotes)` : "";
      const same =
        result.unchanged.length > 0
          ? `; ${result.unchanged.length} already matched their newText`
          : "";
      if (result.failures.length === 0) {
        return result.applied.length > 0
          ? `Applied ${result.applied.length} edit(s) to ${path}${note}${same}`
          : `No changes to ${path}: every edit's oldText equals its newText.`;
      }
      const head =
        result.applied.length > 0
          ? `Applied ${result.applied.length} of ${edits.length} edits to ${path}${note}${same}; ` +
            "the file now contains them. Not applied:"
          : `No edits applied to ${path}:`;
      throw new ToolCallError(
        `${head}\n${result.failures.join("\n")}\n` +
          "Retry only these, against the file as it is now."
      );
    },
  };
}
