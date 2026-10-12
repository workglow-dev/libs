/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolCallError, ToolResultContent } from "@workglow/ai";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCredentialsFile } from "../agent/credentialsFile";
import { PROBED_COMMANDS, probeCommands } from "../agent/environment";
import {
  commandTimeoutSec,
  createBashTool,
  MAX_TIMEOUT_SEC,
  runCommand,
  shellEnv,
} from "../agent/tools/bash";
import type { CodingToolContext } from "../agent/tools/context";
import { applyEdits, createEditTool, normalizeLine } from "../agent/tools/edit";
import { codingSystemPrompt } from "../agent/systemPrompt";
import { createReadTool, imageMimeType, MAX_READ_BYTES } from "../agent/tools/read";
import { countLines, lineAt, truncateHead, truncateTail } from "../agent/tools/truncate";
import { createWriteTool } from "../agent/tools/write";

let dir: string;
let context: CodingToolContext;
const signal = new AbortController().signal;
const call = { toolUseId: "t1", signal, deadline: undefined };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-eval-tools-"));
  context = {
    cwd: dir,
    spillDir: join(dir, ".spill"),
    defaultCommandTimeoutSec: 10,
    images: true,
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("truncate", () => {
  // The split-based definitions the line walkers replaced, kept as the reference.
  const reference = {
    lines: (text: string) => (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n"),
  };

  it("charges a newline only where the text has one", () => {
    expect(truncateTail("abc", 100, 3)).toMatchObject({ text: "abc", truncated: false });
    expect(truncateTail("abc\n", 100, 3)).toMatchObject({ text: "bc\n", truncated: true });
    expect(truncateHead("abc", 100, 3)).toMatchObject({ text: "abc", truncated: false });
    expect(truncateHead("ab\ncd", 100, 5)).toMatchObject({ text: "ab\ncd", truncated: false });
  });

  it("walks lines exactly as splitting them would, without building the array", () => {
    const pieces = ["", "a", "bb", "\n", "\n\n", "ü", "x".repeat(30)];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let n = 0; n < 500; n++) {
      let text = "";
      const parts = Math.floor(next() * 12);
      for (let i = 0; i < parts; i++) text += pieces[Math.floor(next() * pieces.length)];
      const lines = reference.lines(text);
      expect(countLines(text)).toBe(lines.length);
      for (let line = 1; line <= lines.length; line++)
        expect(lineAt(text, line)).toBe(lines[line - 1]);
      for (const [maxLines, maxBytes] of [
        [3, 1000],
        [1000, 20],
        [2, 5],
      ] as const) {
        const head = truncateHead(text, maxLines, maxBytes);
        expect(head.totalLines).toBe(lines.length);
        expect(head.text.split("\n").slice(0, head.keptLines)).toEqual(
          lines.slice(0, head.keptLines)
        );
        const tail = truncateTail(text, maxLines, maxBytes);
        expect(tail.totalLines).toBe(lines.length);
        if (!tail.partialLine) {
          expect(reference.lines(tail.text.length === 0 ? "" : tail.text)).toEqual(
            lines.slice(lines.length - tail.keptLines)
          );
        }
      }
    }
  });

  it("keeps the head of long text and says how much there was", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const head = truncateHead(text, 3, 1000);
    expect(head.text).toBe("line 0\nline 1\nline 2");
    expect(head.truncated).toBe(true);
    expect(head.totalLines).toBe(10);
  });

  it("counts a final newline as the end of the last line", () => {
    const text = Array.from({ length: 5 }, (_, i) => `${i + 1}`).join("\n") + "\n";
    const tail = truncateTail(text, 2, 1000);
    expect(tail.totalLines).toBe(5);
    expect(tail.text).toBe("4\n5\n");
    expect(truncateHead(text, 10, 1000)).toMatchObject({ totalLines: 5, truncated: false });
  });

  it("keeps the tail when the end is what matters", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    expect(truncateTail(text, 2, 1000).text).toBe("line 8\nline 9");
  });

  it("stops at the byte limit before the line limit", () => {
    const text = ["aaaa", "bbbb", "cccc"].join("\n");
    expect(truncateHead(text, 100, 10).keptLines).toBe(2);
  });

  it("keeps the end of a last line longer than the whole budget", () => {
    const tail = truncateTail(`${"x".repeat(100)}ERROR\n`, 100, 21);
    expect(tail.text).toBe(`${"x".repeat(15)}ERROR\n`);
    expect(tail.truncated).toBe(true);
    expect(tail.partialLine).toBe(true);
  });

  it("cuts a long last line on a character boundary", () => {
    // Each "é" is two bytes: an odd budget lands mid-character.
    const tail = truncateTail("é".repeat(50), 100, 9);
    expect(tail.text).toBe("é".repeat(4));
    expect(tail.partialLine).toBe(true);
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

  it("reports an ambiguous match and applies nothing for it", () => {
    const result = applyEdits("x\nx\n", [{ oldText: "x", newText: "y" }], "f");
    expect(result.content).toBe("x\nx\n");
    expect(result.failures).toEqual([expect.stringMatching(/^edits\[0\]: .*2 occurrences/)]);
  });

  it("applies the first of two overlapping edits and reports the second", () => {
    const result = applyEdits(
      "abcdef",
      [
        { oldText: "abcd", newText: "1" },
        { oldText: "cdef", newText: "2" },
      ],
      "f"
    );
    expect(result.content).toBe("1ef");
    expect(result.applied).toEqual([0]);
    expect(result.failures).toEqual([
      expect.stringMatching(/^edits\[1\]: overlaps edits\[0\], which was applied\. Read the file/),
    ]);
  });

  it("counts an edit whose text is already in place as unchanged, not as a failure", () => {
    const result = applyEdits("a", [{ oldText: "a", newText: "a" }], "f");
    expect(result.unchanged).toEqual([0]);
    expect(result.failures).toEqual([]);
  });

  it("finds no blank line in an empty file", () => {
    const result = applyEdits("", [{ oldText: "\n", newText: "inserted" }], "f");
    expect(result.content).toBe("");
    expect(result.failures).toEqual([expect.stringMatching(/^edits\[0\]/)]);
  });

  it("counts overlapping fuzzy matches, so an ambiguous edit is refused", () => {
    // Trailing spaces defeat the exact match; each "a" line pair matches twice.
    const result = applyEdits("a\na\na\n", [{ oldText: "a \na ", newText: "x" }], "f");
    expect(result.failures).toEqual([expect.stringMatching(/found 2 places matching/)]);
  });

  it("searches fuzzily in time proportional to the file, not file × oldText", () => {
    const content = "a\n".repeat(200_000);
    // Thousands of lines that all match, then one that never does: a search that
    // restarts the whole comparison at every line does 400 million of them.
    const oldText = `${"a \n".repeat(2_000)}b`;
    const started = Date.now();
    const result = applyEdits(content, [{ oldText, newText: "x" }], "f");
    expect(result.failures).toEqual([expect.stringMatching(/could not find oldText/)]);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("reports an empty oldText", () => {
    expect(applyEdits("a", [{ oldText: "", newText: "b" }], "f").failures).toEqual([
      expect.stringMatching(/empty/),
    ]);
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

  it("does not take the end of a file for a blank line the oldText asks for", () => {
    const result = applyEdits("foo  \n", [{ oldText: "foo\n\n", newText: "bar\n" }], "f");
    expect(result.content).toBe("foo  \n");
    expect(result.failures).toHaveLength(1);
    // The same edit without the blank line still matches past the trailing spaces.
    expect(applyEdits("foo  \n", [{ oldText: "foo\n", newText: "bar\n" }], "f").content).toBe(
      "bar\n"
    );
  });

  it("normalizes dashes and non-breaking spaces", () => {
    expect(normalizeLine("a—b c  ")).toBe("a-b c");
  });

  it("says what to do when nothing matches", () => {
    expect(applyEdits("abc", [{ oldText: "zzz", newText: "y" }], "f").failures).toEqual([
      expect.stringMatching(/Read the file again/),
    ]);
  });

  it("writes the edits that apply and names the ones that did not", async () => {
    writeFileSync(join(dir, "f.txt"), "one\ntwo\ntwo\n");
    await expect(
      createEditTool(context).execute!(
        {
          path: "f.txt",
          edits: [
            { oldText: "one", newText: "1" },
            { oldText: "two", newText: "2" },
          ],
        },
        call
      )
    ).rejects.toThrow(/Applied 1 of 2 edits[\s\S]*edits\[1\]: .*2 occurrences/);
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("1\ntwo\ntwo\n");
  });

  it("applies concurrent edits through a symlink and its target, losing neither", async () => {
    writeFileSync(join(dir, "real.txt"), "one\ntwo\n");
    symlinkSync(join(dir, "real.txt"), join(dir, "alias.txt"));
    const edit = createEditTool(context);
    await Promise.all([
      edit.execute!({ path: "real.txt", edits: [{ oldText: "one", newText: "1" }] }, call),
      edit.execute!({ path: "alias.txt", edits: [{ oldText: "two", newText: "2" }] }, call),
    ]);
    expect(readFileSync(join(dir, "real.txt"), "utf8")).toBe("1\n2\n");
  });

  it("refuses to edit a file that is not UTF-8, leaving its bytes alone", async () => {
    const path = join(dir, "latin1.txt");
    writeFileSync(path, Buffer.from([0x61, 0xff]));
    await expect(
      createEditTool(context).execute!(
        { path: "latin1.txt", edits: [{ oldText: "a", newText: "b" }] },
        call
      )
    ).rejects.toThrow(/not UTF-8 text/);
    expect([...readFileSync(path)]).toEqual([0x61, 0xff]);
  });

  it("refuses to edit a device, which has no end to read to", async () => {
    await expect(
      createEditTool(context).execute!(
        { path: "/dev/zero", edits: [{ oldText: "a", newText: "b" }] },
        call
      )
    ).rejects.toThrow(/not a regular file/);
  });

  it("refuses to edit a file too large to load", async () => {
    const big = join(dir, "huge.dat");
    writeFileSync(big, "");
    truncateSync(big, MAX_READ_BYTES + 1);
    await expect(
      createEditTool(context).execute!(
        { path: "huge.dat", edits: [{ oldText: "a", newText: "b" }] },
        call
      )
    ).rejects.toThrow(/too large to edit here/);
  });

  it("tells a missing file from one it could not read", async () => {
    const edits = [{ oldText: "a", newText: "b" }];
    await expect(
      createEditTool(context).execute!({ path: "missing.txt", edits }, call)
    ).rejects.toThrow(/File not found: .*missing\.txt\. Use write to create it\./);
    // A path through a regular file fails with ENOTDIR: no file to create either.
    writeFileSync(join(dir, "a-file"), "x");
    const unreadable = createEditTool(context).execute!({ path: "a-file/child", edits }, call);
    await expect(unreadable).rejects.toThrow(/Could not read .*a-file\/child: /);
    await expect(unreadable).rejects.not.toThrow(/Use write/);
    // A directory is no file to edit at all.
    mkdirSync(join(dir, "a-dir"));
    await expect(createEditTool(context).execute!({ path: "a-dir", edits }, call)).rejects.toThrow(
      /not a regular file/
    );
  });

  it("says how many edits already matched when others in the call fail", async () => {
    writeFileSync(join(dir, "p.txt"), "one\nsame\ntwo\ntwo\n");
    await expect(
      createEditTool(context).execute!(
        {
          path: "p.txt",
          edits: [
            { oldText: "one", newText: "1" },
            { oldText: "same", newText: "same" },
            { oldText: "two", newText: "2" },
          ],
        },
        call
      )
    ).rejects.toThrow(/Applied 1 of 3 edits to .*p\.txt; 1 already matched their newText/);
  });

  it("leaves the file byte-identical when every edit fails, CRLF included", async () => {
    const path = join(dir, "all-failed.txt");
    writeFileSync(path, "a\r\nb\r\n");
    await expect(
      createEditTool(context).execute!(
        { path: "all-failed.txt", edits: [{ oldText: "not there", newText: "x" }] },
        call
      )
    ).rejects.toThrow(/No edits applied/);
    expect(readFileSync(path)).toEqual(Buffer.from("a\r\nb\r\n"));
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

  it("writes a mixed file back in the ending of its first line break, as pi does", async () => {
    writeFileSync(join(dir, "mixed.txt"), "a\nb\r\nc\n");
    await createEditTool(context).execute!(
      { path: "mixed.txt", edits: [{ oldText: "c", newText: "C" }] },
      call
    );
    expect(readFileSync(join(dir, "mixed.txt"), "utf8")).toBe("a\nb\nC\n");
  });

  it("reports a missing file as a tool error", async () => {
    const tool = createEditTool(context);
    await expect(
      tool.execute!({ path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] }, call)
    ).rejects.toBeInstanceOf(ToolCallError);
  });
});

describe("edit under concurrency", () => {
  it("keeps both of two edits made to one file at the same time", async () => {
    writeFileSync(join(dir, "both.txt"), "alpha\nbeta\n");
    const edit = createEditTool(context);
    await Promise.all([
      edit.execute!({ path: "both.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] }, call),
      edit.execute!({ path: "both.txt", edits: [{ oldText: "beta", newText: "BETA" }] }, call),
    ]);
    expect(readFileSync(join(dir, "both.txt"), "utf8")).toBe("ALPHA\nBETA\n");
  });
});

describe("read and write", () => {
  it("writes a file under new directories and reads it back", async () => {
    await createWriteTool(context).execute!({ path: "a/b/c.txt", content: "hello\n" }, call);
    expect(await createReadTool(context).execute!({ path: "a/b/c.txt" }, call)).toBe("hello");
  });

  it("reports a path it cannot stat as unreadable, not as missing", async () => {
    writeFileSync(join(dir, "plain.txt"), "x");
    // A file used as a directory fails with ENOTDIR: there, but not readable as asked.
    await expect(
      createReadTool(context).execute!({ path: "plain.txt/child" }, call)
    ).rejects.toThrow(/Could not read .*plain\.txt\/child: /);
    await expect(createReadTool(context).execute!({ path: "absent.txt" }, call)).rejects.toThrow(
      /File not found: /
    );
  });

  it("refuses a file too large to load, before reading any of it", async () => {
    const big = join(dir, "huge.log");
    writeFileSync(big, "");
    truncateSync(big, MAX_READ_BYTES + 1);
    await expect(createReadTool(context).execute!({ path: "huge.log" }, call)).rejects.toThrow(
      /too large to read whole\. Use bash/
    );
  });

  it("refuses a path that is not a regular file", async () => {
    await expect(createReadTool(context).execute!({ path: "/dev/zero" }, call)).rejects.toThrow(
      "is not a regular file"
    );
  });

  it("refuses to write anything but a regular file, so a FIFO cannot hang it", async () => {
    const fifo = join(dir, "pipe");
    execFileSync("mkfifo", [fifo]);
    await expect(
      createWriteTool(context).execute!({ path: "pipe", content: "x" }, call)
    ).rejects.toThrow(/is not a regular file/);
    await expect(
      createWriteTool(context).execute!({ path: ".", content: "x" }, call)
    ).rejects.toThrow(/is not a regular file/);
  });

  it("refuses an offset or limit below 1", async () => {
    writeFileSync(join(dir, "two.txt"), "a\nb\n");
    const read = createReadTool(context);
    await expect(read.execute!({ path: "two.txt", offset: 0 }, call)).rejects.toThrow(
      "offset must be 1 or more"
    );
    await expect(read.execute!({ path: "two.txt", limit: 0 }, call)).rejects.toThrow(
      "limit must be 1 or more"
    );
  });

  it("counts a final newline as the end of the last line, not a line of its own", async () => {
    writeFileSync(join(dir, "one.txt"), "hello\n");
    await expect(
      createReadTool(context).execute!({ path: "one.txt", offset: 2 }, call)
    ).rejects.toThrow("offset 2 is past the end of");
  });

  it("cuts a line too long for the budget by bytes, not characters", async () => {
    writeFileSync(join(dir, "wide.txt"), "😀".repeat(30_000));
    const out = (await createReadTool(context).execute!({ path: "wide.txt" }, call)) as string;
    const head = out.split("\n\n[Line 1")[0]!;
    expect(Buffer.byteLength(head, "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(head).toBe("😀".repeat(12_800));
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

  it("bounds a directory listing like a file", async () => {
    mkdirSync(join(dir, "many"));
    for (let i = 0; i < 2100; i++) writeFileSync(join(dir, "many", `f${i}`), "");
    const out = (await createReadTool(context).execute!({ path: "many" }, call)) as string;
    expect(out).toContain(
      "[Showing 2000 of 2100 entries, in directory order rather than by name. Use bash"
    );
    expect(out.split("\n").filter((line) => /^f\d+$/.test(line))).toHaveLength(2000);
  });

  it("lists a directory instead of failing", async () => {
    writeFileSync(join(dir, "x.txt"), "");
    const out = (await createReadTool(context).execute!({ path: "." }, call)) as string;
    expect(out).toContain("x.txt");
  });

  it("returns an image as an image the model can see", async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 0]),
    ]);
    writeFileSync(join(dir, "board.png"), png);
    const out = await createReadTool(context).execute!({ path: "board.png" }, call);
    expect(out).toBeInstanceOf(ToolResultContent);
    const content = (out as ToolResultContent).content;
    expect(content[0]).toMatchObject({ type: "text" });
    expect(content[1]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: png.toString("base64"),
    });
  });

  it("refuses an image as binary when images are switched off", async () => {
    writeFileSync(
      join(dir, "board.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
    );
    await expect(
      createReadTool({ ...context, images: false }).execute!({ path: "board.png" }, call)
    ).rejects.toThrow(/binary/);
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

  it("runs commands without the model's credentials in their environment", async () => {
    const saved = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    process.env.ANTHROPIC_AUTH_TOKEN = "tok-secret";
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
    try {
      const out = String(await createBashTool(context).execute!({ command: "env" }, call));
      expect(out).not.toContain("sk-secret");
      expect(out).not.toContain("tok-secret");
      expect(out).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:1");
      expect(
        shellEnv({ OPENAI_API_KEY: "k", HF_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", PATH: "/bin" })
      ).toEqual({ PATH: "/bin" });
    } finally {
      process.env = saved;
    }
  });

  it.skipIf(process.platform !== "linux")(
    "keeps keys loaded from a credentials file out of reach of its commands",
    async () => {
      const saved = { ...process.env };
      const file = join(dir, "credentials.json");
      writeFileSync(file, JSON.stringify({ WORKGLOW_TEST_API_KEY: "sk-from-file" }));
      try {
        expect(loadCredentialsFile(file)).toEqual(["WORKGLOW_TEST_API_KEY"]);
        expect(process.env.WORKGLOW_TEST_API_KEY).toBe("sk-from-file");
        expect(existsSync(file)).toBe(false);
        // The shell's own environment, and its parent's starting environment, which
        // a filter on the shell's environment cannot reach.
        const out = String(
          await createBashTool(context).execute!(
            { command: "env; tr '\\0' '\\n' < /proc/$PPID/environ" },
            call
          )
        );
        expect(out).toContain("PATH=");
        expect(out).not.toContain("sk-from-file");
      } finally {
        process.env = saved;
      }
    }
  );

  it("deletes a credentials file even when it cannot be read as one", () => {
    const file = join(dir, "credentials.json");
    writeFileSync(file, "not json");
    expect(() => loadCredentialsFile(file, {})).toThrow(/not valid JSON/);
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, JSON.stringify({ KEY: 1 }));
    expect(() => loadCredentialsFile(file, {})).toThrow(/non-string value for KEY/);
    expect(existsSync(file)).toBe(false);
  });

  it("kills a command at its timeout", async () => {
    const started = Date.now();
    await expect(
      createBashTool(context).execute!({ command: "sleep 30", timeout: 1 }, call)
    ).rejects.toThrow(/timed out after 1s/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("returns from a timeout only once a child ignoring SIGTERM is gone too", async () => {
    const log = join(dir, "bg.txt");
    await expect(
      createBashTool(context).execute!(
        {
          command: `(trap '' TERM; while true; do echo x >> ${log}; sleep 0.1; done) & sleep 30`,
          timeout: 1,
        },
        call
      )
    ).rejects.toThrow(/timed out after 1s/);
    const size = statSync(log).size;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(statSync(log).size).toBe(size);
  });

  it("refuses a timeout under one second without running the command", async () => {
    for (const timeout of [0, -5, 0.5]) {
      await expect(
        createBashTool(context).execute!({ command: "touch ran-anyway", timeout }, call)
      ).rejects.toThrow(/at least 1 second/);
    }
    expect(existsSync(join(context.cwd, "ran-anyway"))).toBe(false);
  });

  it("refuses a timeout longer than a timer can be set, rather than shortening it", async () => {
    await expect(
      createBashTool(context).execute!(
        { command: "touch too-long", timeout: MAX_TIMEOUT_SEC + 1 },
        call
      )
    ).rejects.toThrow(/at most \d+ seconds/);
    expect(existsSync(join(context.cwd, "too-long"))).toBe(false);
  });

  it("cuts a timeout to the time left, and only when it is shorter", () => {
    expect(commandTimeoutSec(120, undefined, 0)).toEqual({ sec: 120, capped: false });
    expect(commandTimeoutSec(120, 300_000, 0)).toEqual({ sec: 120, capped: false });
    expect(commandTimeoutSec(600, 90_500, 0)).toEqual({ sec: 90, capped: true });
    expect(commandTimeoutSec(600, 100, 0)).toEqual({ sec: 1, capped: true });
  });

  it("kills a command when the task's time runs out, whatever timeout it asked for", async () => {
    const started = Date.now();
    await expect(
      createBashTool(context).execute!(
        { command: "sleep 30", timeout: 600 },
        { ...call, deadline: Date.now() + 1_500 }
      )
    ).rejects.toThrow(/all the time left/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("does not run a command when no time is left", async () => {
    await expect(
      createBashTool(context).execute!(
        { command: "touch ran.txt" },
        { ...call, deadline: Date.now() - 1 }
      )
    ).rejects.toThrow(
      "No time is left for this task; the command was not run. Finish with what you have."
    );
    expect(readdirSync(dir)).not.toContain("ran.txt");
  });

  it("does not run a command with under a second left, which a 1 s timeout would overrun", async () => {
    await expect(
      createBashTool(context).execute!(
        { command: "touch ran.txt" },
        { ...call, deadline: Date.now() + 500 }
      )
    ).rejects.toThrow(/No time is left/);
    expect(readdirSync(dir)).not.toContain("ran.txt");
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
    expect(out).toMatch(/^\[Output truncated: showing the last 2000 of 5000 lines/);
    expect(out.trimEnd().endsWith("5000")).toBe(true);
    const spilled = readdirSync(context.spillDir);
    expect(spilled).toHaveLength(1);
    expect(readFileSync(join(context.spillDir, spilled[0]!), "utf8").startsWith("1\n2\n")).toBe(
      true
    );
  });
});

describe("runCommand", () => {
  it("does not time out a command that finished, while a background child drains", async () => {
    const result = await runCommand("sleep 0.85; sleep 30 & echo done", dir, 1_000, signal);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain("done");
  });

  it("never starts a command whose signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    const marker = join(dir, "ran");
    await expect(runCommand(`touch ${marker}`, dir, 10_000, controller.signal)).rejects.toThrow(
      "stopped"
    );
    expect(readdirSync(dir)).not.toContain("ran");
  });

  it("keeps the end of an output past the capture cap", async () => {
    const result = await runCommand(
      "head -c 17000000 /dev/zero | tr '\\0' a; echo; echo THE-END",
      dir,
      30_000,
      signal
    );
    expect(result.droppedBytes).toBeGreaterThan(0);
    expect(result.output.trimEnd().endsWith("THE-END")).toBe(true);
  });
});

describe("imageMimeType", () => {
  it("recognises the formats vision providers take, by their leading bytes", () => {
    expect(imageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(imageMimeType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(imageMimeType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(imageMimeType(Buffer.from("plain text"))).toBeUndefined();
  });
});

describe("probeCommands", () => {
  it("probes the tools coding tasks reach for beyond the language runtimes", () => {
    expect(PROBED_COMMANDS).toEqual(
      expect.arrayContaining(["file", "xxd", "strings", "7zz", "7z"])
    );
  });

  it("finds executables on PATH and lists the rest as missing", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "python3"), "#!/bin/sh\n");
    chmodSync(join(bin, "python3"), 0o755);
    writeFileSync(join(bin, "rg"), "not executable");
    expect(probeCommands(["python3", "python", "rg"], bin)).toEqual({
      found: ["python3"],
      missing: ["python", "rg"],
    });
  });
});

describe("codingSystemPrompt", () => {
  const env = { cwd: "/app", platform: "linux x64", date: "2026-10-07", commands: undefined };
  it("asks for verification once the change is complete, not after every edit", () => {
    const prompt = codingSystemPrompt({ ...env, concise: true, images: true });
    expect(prompt).toContain(
      "- Verify once the change is complete: run the code or its tests then, not after every edit."
    );
    expect(prompt).not.toContain("Verify your work");
  });
  it("asks for concision only when switched on", () => {
    expect(codingSystemPrompt({ ...env, concise: true, images: true })).toContain("Be concise");
    expect(codingSystemPrompt({ ...env, concise: false, images: true })).not.toContain(
      "Be concise"
    );
  });
  it("tells the model read shows images only when it does", () => {
    expect(codingSystemPrompt({ ...env, concise: true, images: true })).toContain(
      "shows you images"
    );
    expect(codingSystemPrompt({ ...env, concise: true, images: false })).not.toContain("images");
  });
  it("names the commands it found and the ones that are missing", () => {
    const prompt = codingSystemPrompt({
      ...env,
      concise: true,
      images: true,
      commands: { found: ["python3", "git"], missing: ["python", "rg"] },
    });
    expect(prompt).toContain("commands on PATH: python3, git");
    expect(prompt).toContain("not installed: python, rg");
  });
});
