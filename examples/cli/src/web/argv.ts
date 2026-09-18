/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebCommandNode } from "./commandTree";

/**
 * What the page describes and the server runs. Kept free of `node:` imports:
 * the browser composes the same value and renders the same line from it, so
 * what you read on screen is what executes.
 */
export interface WebInvocation {
  readonly path: readonly string[];
  readonly args: readonly string[];
  readonly options: Readonly<Record<string, string | boolean>>;
  /**
   * Task config values, which the CLI reads from SINGLE-dash flags (`-delay 5`)
   * so they cannot collide with the double-dash input flags. Kept apart here
   * for the same reason, rather than hoping a name never appears in both.
   */
  readonly config?: Readonly<Record<string, string | boolean>>;
}

/** Characters that would change meaning if the line were pasted into a shell. */
const NEEDS_QUOTING = /[\s"'$`\\|&;<>()*?!#~[\]{}]/;

export function composeArgv(invocation: WebInvocation): string[] {
  const argv: string[] = [...invocation.path, ...invocation.args];
  for (const [name, value] of Object.entries(invocation.options)) {
    if (value === false || value === undefined) continue;
    argv.push(`--${name}`);
    if (value !== true) argv.push(String(value));
  }
  for (const [name, value] of Object.entries(invocation.config ?? {})) {
    if (value === false || value === undefined) continue;
    argv.push(`-${name}`);
    if (value !== true) argv.push(String(value));
  }
  return argv;
}

/**
 * Characters that cannot survive being shown on one line.
 *
 * A newline inside double quotes is legal shell, but the console draws this
 * line in a `<code>` element, where HTML folds it into a space — so the command
 * you read is not the command that would run, and selecting it copies the
 * flattened version. A tab has the same problem and is invisible besides.
 */
const NEEDS_ANSI_C = /[\n\r\t]/;

/**
 * One argument, as you would have typed it.
 *
 * A value carrying a line break is written in ANSI-C form (`$'a\nb'`), which
 * keeps the whole invocation on one line and round-trips exactly through a
 * copy, a paste and a shell. That form is bash, zsh and ksh rather than POSIX
 * `sh` — a deliberate trade, because the portable alternative is a literal
 * newline, and this line is read on screen at least as often as it is pasted.
 */
function quote(value: string): string {
  if (value === "") return '""';
  if (NEEDS_ANSI_C.test(value)) {
    // Backslashes first: escaping them after the others would double the
    // backslashes this function just introduced.
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `$'${escaped}'`;
  }
  return NEEDS_QUOTING.test(value) ? `"${value.replace(/(["\\$`])/g, "\\$1")}"` : value;
}

/** The invocation as you would have typed it. */
export function renderCliLine(binary: string, invocation: WebInvocation): string {
  const parts = [binary, ...invocation.path, ...invocation.args.map(quote)];
  for (const [name, value] of Object.entries(invocation.options)) {
    if (value === false || value === undefined) continue;
    parts.push(`--${name}`);
    if (value !== true) parts.push(quote(String(value)));
  }
  for (const [name, value] of Object.entries(invocation.config ?? {})) {
    if (value === false || value === undefined) continue;
    parts.push(`-${name}`);
    if (value !== true) parts.push(quote(String(value)));
  }
  return parts.join(" ");
}

/**
 * The only gate between a page and `spawn`.
 *
 * An option the command does not declare is rejected rather than passed
 * through: this is the boundary where a browser's JSON becomes a process
 * argument, and commander would happily take an unknown flag on a command that
 * allows them.
 */
export function validateInvocation(
  node: WebCommandNode,
  invocation: WebInvocation,
  schemaKeys: ReadonlySet<string> = new Set(),
  configKeys: ReadonlySet<string> = new Set()
): string[] {
  const errors: string[] = [];

  node.args.forEach((argument, index) => {
    const value = invocation.args[index];
    if (argument.required && (value === undefined || value === "")) {
      errors.push(`${argument.name} is required`);
      return;
    }
    if (value !== undefined && argument.choices && !argument.choices.includes(value)) {
      errors.push(`${argument.name} must be one of ${argument.choices.join(", ")}`);
    }
  });
  if (invocation.args.length > node.args.length && !node.args.some((a) => a.variadic)) {
    errors.push(`${node.name} takes ${node.args.length} argument(s)`);
  }

  const declared = new Map(node.options.map((option) => [option.name, option]));
  for (const [name, value] of Object.entries(invocation.options)) {
    const option = declared.get(name);
    if (!option) {
      // A schema-derived flag is not declared on the command — `task run` and
      // `workflow run` take theirs from the task's or graph's input schema —
      // so the allow-list is "declared, or a field this invocation resolved".
      if (!schemaKeys.has(name)) errors.push(`unknown option "${name}"`);
      continue;
    }
    if (option.kind === "boolean" && typeof value !== "boolean") {
      errors.push(`${name} is a flag and takes no value`);
      continue;
    }
    if (option.kind === "value" && typeof value === "boolean") {
      errors.push(`${name} needs a value`);
      continue;
    }
    if (option.choices && typeof value === "string" && !option.choices.includes(value)) {
      errors.push(`${name} must be one of ${option.choices.join(", ")}`);
    }
  }
  for (const name of Object.keys(invocation.config ?? {})) {
    if (!configKeys.has(name)) errors.push(`unknown config "${name}"`);
  }
  for (const option of node.options) {
    if (option.required && invocation.options[option.name] === undefined) {
      errors.push(`${option.name} is required`);
    }
  }
  return errors;
}
