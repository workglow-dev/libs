/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolCallError } from "@workglow/ai";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool } from "../agent/tools/bash";
import type { CodingToolContext } from "../agent/tools/context";
import { applyEdits, createEditTool, normalizeLine } from "../agent/tools/edit";
import { createReadTool } from "../agent/tools/read";
import { truncateHead, truncateTail } from "../agent/tools/truncate";
import { createWriteTool } from "../agent/tools/write";

let dir: string;
let context: CodingToolContext;
const signal = new AbortController().signal;
const call = { toolUseId: "t1", signal };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-eval-tools-"));
  context = { cwd: dir, spillDir: join(dir, ".spill"), defaultCommandTimeoutSec: 10 };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("truncate", () => {
  it("keeps the head of long text and says how much there was", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const head = truncateHead(text, 3, 1000);
    expect(head.text).toBe("line 0\nline 1\nline 2");
    expect(head.truncated).toBe(true);
    expect(head.totalLines).toBe(10);
  });

  it("keeps the tail when the end is what matters", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    expect(truncateTail(text, 2, 1000).text).toBe("line 8\nline 9");
  });

  it("stops at the byte limit before the line limit", () => {
    const text = ["aaaa", "bbbb", "cccc"].join("\n");
    expect(truncateHead(text, 100, 10).keptLines).toBe(2);
  });
});

describe("edit", () => {
  it("replaces a unique exact match", () => {
    expect(applyEdits("a\nb\nc\n", [{ oldText: "b", newText: "B" }], "f").content).toBe(
      "a\nB\nc\n"
    );
  });

  it("locates every edit against the original text", () => {
    const result = applyEdits(
      "one\ntwo\nthree\n",
      [
        { oldText: "three", newText: "3" },
        { oldText: "one", newText: "1\none and a half" },
      ],
      "f"
    );
    expect(result.content).toBe("1\none and a half\ntwo\n3\n");
  });

  it("refuses an ambiguous match", () => {
    expect(() => applyEdits("x\nx\n", [{ oldText: "x", newText: "y" }], "f")).toThrow(
      /2 occurrences/
    );
  });

  it("refuses overlapping edits", () => {
    expect(() =>
      applyEdits(
        "abcdef",
        [
          { oldText: "abcd", newText: "1" },
          { oldText: "cdef", newText: "2" },
        ],
        "f"
      )
    ).toThrow(/overlap/);
  });

  it("refuses a no-op and an empty oldText", () => {
    expect(() => applyEdits("a", [{ oldText: "a", newText: "a" }], "f")).toThrow(/identical/);
    expect(() => applyEdits("a", [{ oldText: "", newText: "b" }], "f")).toThrow(/empty/);
  });

  it("matches whole lines that differ only in trailing whitespace and typographic quotes", () => {
    const content = "const s = “hi”;   \nnext();\n";
    const result = applyEdits(
      content,
      [{ oldText: 'const s = "hi";\n', newText: 'const s = "bye";\n' }],
      "f"
    );
    expect(result.content).toBe('const s = "bye";\nnext();\n');
    expect(result.fuzzy).toBe(1);
  });

  it("normalizes dashes and non-breaking spaces", () => {
    expect(normalizeLine("a—b c  ")).toBe("a-b c");
  });

  it("says what to do when nothing matches", () => {
    expect(() => applyEdits("abc", [{ oldText: "zzz", newText: "y" }], "f")).toThrow(
      /Read the file again/
    );
  });

  it("keeps CRLF line endings and a BOM through the tool", async () => {
    const path = join(dir, "crlf.txt");
    writeFileSync(path, "﻿one\r\ntwo\r\n");
    const tool = createEditTool(context);
    await tool.execute!(
      { path: "crlf.txt", edits: [{ oldText: "one\ntwo", newText: "1\n2" }] },
      call
    );
    expect(readFileSync(path, "utf8")).toBe("﻿1\r\n2\r\n");
  });

  it("reports a missing file as a tool error", async () => {
    const tool = createEditTool(context);
    await expect(
      tool.execute!({ path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] }, call)
    ).rejects.toBeInstanceOf(ToolCallError);
  });
});

describe("read and write", () => {
  it("writes a file under new directories and reads it back", async () => {
    await createWriteTool(context).execute!({ path: "a/b/c.txt", content: "hello\n" }, call);
    expect(await createReadTool(context).execute!({ path: "a/b/c.txt" }, call)).toBe("hello\n");
  });

  it("pages a long file and names the next offset", async () => {
    writeFileSync(
      join(dir, "long.txt"),
      Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join("\n")
    );
    const out = (await createReadTool(context).execute!(
      { path: "long.txt", offset: 11, limit: 5 },
      call
    )) as string;
    expect(out.startsWith("L11\nL12\nL13\nL14\nL15")).toBe(true);
    expect(out).toContain("Use offset=16 to continue");
  });

  it("lists a directory instead of failing", async () => {
    writeFileSync(join(dir, "x.txt"), "");
    const out = (await createReadTool(context).execute!({ path: "." }, call)) as string;
    expect(out).toContain("x.txt");
  });

  it("refuses a binary file", async () => {
    writeFileSync(join(dir, "bin"), Buffer.from([1, 0, 2, 0]));
    await expect(createReadTool(context).execute!({ path: "bin" }, call)).rejects.toThrow(/binary/);
  });
});

describe("bash", () => {
  it("returns combined output", async () => {
    const out = await createBashTool(context).execute!({ command: "echo out; echo err >&2" }, call);
    expect(out).toBe("out\nerr\n");
  });

  it("runs in the working directory", async () => {
    expect(await createBashTool(context).execute!({ command: "pwd" }, call)).toBe(`${dir}\n`);
  });

  it("turns a non-zero exit into a tool error carrying the output", async () => {
    await expect(
      createBashTool(context).execute!({ command: "echo nope; exit 3" }, call)
    ).rejects.toThrow(/nope[\s\S]*exited with code 3/);
  });

  it("kills a command at its timeout", async () => {
    const started = Date.now();
    await expect(
      createBashTool(context).execute!({ command: "sleep 30", timeout: 1 }, call)
    ).rejects.toThrow(/timed out after 1s/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("does not wait for a process the command left in the background", async () => {
    const started = Date.now();
    const out = await createBashTool(context).execute!(
      { command: "sleep 30 & echo started" },
      call
    );
    expect(out).toBe("started\n");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("shows the tail of long output and spills the rest to a file", async () => {
    const out = (await createBashTool(context).execute!({ command: "seq 1 5000" }, call)) as string;
    expect(out).toMatch(/^\[Output truncated: showing the last 2000 of 5001 lines/);
    expect(out.trimEnd().endsWith("5000")).toBe(true);
    const spilled = readdirSync(context.spillDir);
    expect(spilled).toHaveLength(1);
    expect(readFileSync(join(context.spillDir, spilled[0]!), "utf8").startsWith("1\n2\n")).toBe(
      true
    );
  });
});
