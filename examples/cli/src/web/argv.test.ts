/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { composeArgv, renderCliLine, validateInvocation, type WebInvocation } from "./argv";
import type { WebCommandNode } from "./commandTree";

const invocation: WebInvocation = {
  path: ["workflow", "run"],
  args: ["chat-sample"],
  options: { prompt: "Draft a note", model: "claude-sonnet-5", "dry-run": true, quiet: false },
};

describe("composeArgv", () => {
  it("puts the path first, then positionals, then flags", () => {
    expect(composeArgv(invocation)).toEqual([
      "workflow",
      "run",
      "chat-sample",
      "--prompt",
      "Draft a note",
      "--model",
      "claude-sonnet-5",
      "--dry-run",
    ]);
  });

  it("passes a value through untouched — argv needs no shell quoting", () => {
    expect(composeArgv({ path: ["x"], args: [], options: { p: 'a "b" c' } })).toEqual([
      "x",
      "--p",
      'a "b" c',
    ]);
  });
});

describe("renderCliLine", () => {
  it("quotes only what a shell would need quoted", () => {
    expect(renderCliLine("workglow", invocation)).toBe(
      'workglow workflow run chat-sample --prompt "Draft a note" --model claude-sonnet-5 --dry-run'
    );
  });

  it("escapes a quote rather than ending the string early", () => {
    expect(renderCliLine("w", { path: ["x"], args: [], options: { p: 'say "hi"' } })).toBe(
      'w x --p "say \\"hi\\""'
    );
  });
});

const node: WebCommandNode = {
  path: ["workflow", "run"],
  name: "run",
  description: "",
  children: [],
  args: [{ name: "id", description: "", required: true, variadic: false, choices: undefined }],
  options: [
    {
      name: "model",
      flags: "--model <id>",
      description: "",
      kind: "value",
      required: false,
      defaultValue: undefined,
      choices: ["a", "b"],
    },
    {
      name: "force",
      flags: "--force",
      description: "",
      kind: "boolean",
      required: false,
      defaultValue: undefined,
      choices: undefined,
    },
  ],
};

describe("config flags", () => {
  it("composes with one dash, which is how the CLI tells them from input", () => {
    const withConfig = {
      path: ["task", "run"],
      args: ["Delay"],
      options: {},
      config: { delay: "400" },
    };
    expect(composeArgv(withConfig)).toEqual(["task", "run", "Delay", "-delay", "400"]);
    expect(renderCliLine("workglow", withConfig)).toBe("workglow task run Delay -delay 400");
  });
});

describe("validateInvocation", () => {
  it("reports a missing required argument", () => {
    expect(validateInvocation(node, { path: node.path, args: [], options: {} })).toEqual([
      "id is required",
    ]);
  });

  it("refuses an option the command does not declare", () => {
    expect(
      validateInvocation(node, { path: node.path, args: ["x"], options: { nope: "1" } })
    ).toEqual(['unknown option "nope"']);
  });

  it("refuses a value outside the declared choices", () => {
    expect(
      validateInvocation(node, { path: node.path, args: ["x"], options: { model: "c" } })
    ).toEqual(["model must be one of a, b"]);
  });

  it("refuses a value on a flag and a flag with no value", () => {
    expect(
      validateInvocation(node, { path: node.path, args: ["x"], options: { force: "yes" } })
    ).toEqual(["force is a flag and takes no value"]);
    expect(
      validateInvocation(node, { path: node.path, args: ["x"], options: { model: true } })
    ).toEqual(["model needs a value"]);
  });

  it("accepts a schema-derived flag the command never declared", () => {
    const invocationWithSchemaFlag = {
      path: node.path,
      args: ["x"],
      options: { prompt: "hello" },
    };
    expect(validateInvocation(node, invocationWithSchemaFlag)).toEqual(['unknown option "prompt"']);
    expect(validateInvocation(node, invocationWithSchemaFlag, new Set(["prompt"]))).toEqual([]);
  });

  it("refuses a config key the resolved schema does not name", () => {
    const withConfig = { path: node.path, args: ["x"], options: {}, config: { nope: "1" } };
    expect(validateInvocation(node, withConfig, new Set(), new Set(["delay"]))).toEqual([
      'unknown config "nope"',
    ]);
    expect(
      validateInvocation(
        node,
        { ...withConfig, config: { delay: "5" } },
        new Set(),
        new Set(["delay"])
      )
    ).toEqual([]);
  });

  it("accepts a complete invocation", () => {
    expect(
      validateInvocation(node, {
        path: node.path,
        args: ["x"],
        options: { model: "a", force: true },
      })
    ).toEqual([]);
  });
});

/**
 * A multi-line value used to render with a literal newline in it. That is legal
 * shell, but the console draws the line in a `<code>` element, so the break
 * folded into a space: what you read — and what selecting the line copied —
 * was a command that would have run a different string.
 */
describe("multi-line values", () => {
  const lineFor = (value: string) =>
    renderCliLine("workglow", { path: ["agent", "chat"], args: [], options: { system: value } });

  it("keeps the whole invocation on one line", () => {
    const line = lineFor("first\nsecond");
    expect(line).toBe("workglow agent chat --system $'first\\nsecond'");
    expect(line).not.toContain("\n");
  });

  it("escapes what ANSI-C quoting would otherwise re-interpret", () => {
    // A backslash stays one backslash, a quote closes nothing, and a tab is
    // written rather than left invisible.
    expect(lineFor("a\\b\nc")).toBe("workglow agent chat --system $'a\\\\b\\nc'");
    expect(lineFor("it's\nhere")).toBe("workglow agent chat --system $'it\\'s\\nhere'");
    expect(lineFor("col\tone\nrow")).toBe("workglow agent chat --system $'col\\tone\\nrow'");
    expect(lineFor("a\r\nb")).toBe("workglow agent chat --system $'a\\r\\nb'");
  });

  it("leaves single-line values on the double-quoted form", () => {
    expect(lineFor("just one line")).toBe('workglow agent chat --system "just one line"');
    expect(lineFor("plain")).toBe("workglow agent chat --system plain");
  });

  /** The run itself is unaffected: `spawn` takes the argv, not the rendered line. */
  it("does not quote what is handed to spawn", () => {
    expect(
      composeArgv({ path: ["agent", "chat"], args: [], options: { system: "first\nsecond" } })
    ).toEqual(["agent", "chat", "--system", "first\nsecond"]);
  });
});
