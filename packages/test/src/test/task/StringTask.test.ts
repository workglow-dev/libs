/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  StringConcatTask,
  StringIncludesTask,
  StringJoinTask,
  StringLengthTask,
  StringLowerCaseTask,
  StringReplaceTask,
  StringSliceTask,
  StringTrimTask,
  StringUpperCaseTask,
} from "@workglow/tasks";
import * as tasks from "@workglow/tasks";
import { setLogger } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { describe, expect, test } from "vitest";

describe("StringTask", () => {
  let logger = getTestingLogger();
  setLogger(logger);

  describe("StringConcatTask", () => {
    test("joins in the order the ports are declared, not the order values arrived", async () => {
      const inputSchema = {
        type: "object",
        properties: { greeting: { type: "string" }, name: { type: "string" } },
        additionalProperties: { type: "string" },
      } as const;
      const task = new StringConcatTask({ inputSchema } as never);
      const result = await task.run({ name: "World", greeting: "Hello, " });
      expect(result.text).toBe("Hello, World");
    });

    test("orders undeclared ports by name", async () => {
      const result = await new StringConcatTask().run({ b: "2", c: "3", a: "1" });
      expect(result.text).toBe("123");
    });

    test("concatenates two strings", async () => {
      const task = new StringConcatTask();
      const result = await task.run({ a: "hello", b: " world" });
      expect(result.text).toBe("hello world");
    });

    test("concatenates empty strings", async () => {
      const task = new StringConcatTask();
      const result = await task.run({ a: "", b: "" });
      expect(result.text).toBe("");
    });
  });

  describe("StringJoinTask", () => {
    test("joins strings with separator", async () => {
      const task = new StringJoinTask();
      const result = await task.run({ texts: ["a", "b", "c"], separator: ", " });
      expect(result.text).toBe("a, b, c");
    });

    test("joins with default empty separator", async () => {
      const task = new StringJoinTask();
      const result = await task.run({ texts: ["a", "b", "c"] });
      expect(result.text).toBe("abc");
    });

    test("joins single element", async () => {
      const task = new StringJoinTask();
      const result = await task.run({ texts: ["only"], separator: "-" });
      expect(result.text).toBe("only");
    });
  });

  describe("StringUpperCaseTask", () => {
    test("converts to upper case", async () => {
      const task = new StringUpperCaseTask();
      const result = await task.run({ text: "hello world" });
      expect(result.text).toBe("HELLO WORLD");
    });
  });

  describe("StringLowerCaseTask", () => {
    test("converts to lower case", async () => {
      const task = new StringLowerCaseTask();
      const result = await task.run({ text: "HELLO WORLD" });
      expect(result.text).toBe("hello world");
    });
  });

  describe("StringTrimTask", () => {
    test("trims whitespace", async () => {
      const task = new StringTrimTask();
      const result = await task.run({ text: "  hello  " });
      expect(result.text).toBe("hello");
    });

    test("trims tabs and newlines", async () => {
      const task = new StringTrimTask();
      const result = await task.run({ text: "\n\thello\n\t" });
      expect(result.text).toBe("hello");
    });
  });

  describe("StringReplaceTask", () => {
    test("replaces all occurrences", async () => {
      const task = new StringReplaceTask();
      const result = await task.run({ text: "foo bar foo", search: "foo", replace: "baz" });
      expect(result.text).toBe("baz bar baz");
    });

    test("replaces with empty string", async () => {
      const task = new StringReplaceTask();
      const result = await task.run({ text: "hello world", search: " ", replace: "" });
      expect(result.text).toBe("helloworld");
    });

    test("inserts the replacement literally, `$` patterns included", async () => {
      // String.replaceAll(string, string) expands `$&`, `$$`, `$1`… in the replacement.
      const task = new StringReplaceTask();
      const result = await task.run({ text: "price: 10", search: "10", replace: "$& USD ($$5)" });
      expect(result.text).toBe("price: $& USD ($$5)");
    });
  });

  describe("StringSliceTask", () => {
    test("slices from start to end", async () => {
      const task = new StringSliceTask();
      const result = await task.run({ text: "hello world", start: 0, end: 5 });
      expect(result.text).toBe("hello");
    });

    test("slices from start without end", async () => {
      const task = new StringSliceTask();
      const result = await task.run({ text: "hello world", start: 6 });
      expect(result.text).toBe("world");
    });

    test("supports negative indexing", async () => {
      const task = new StringSliceTask();
      const result = await task.run({ text: "hello world", start: -5 });
      expect(result.text).toBe("world");
    });
  });

  describe("StringLengthTask", () => {
    test.each([
      [undefined, 7],
      ["code-units", 7],
      ["code-points", 6],
      ["graphemes", 5],
    ] as const)("counts %s", async (unit, want) => {
      // "e" + combining acute is one grapheme of two code points; the emoji is one
      // code point of two code units.
      const text = "ae\u0301b\u{1F600}x";
      const task = new StringLengthTask(unit ? ({ unit } as never) : undefined);
      expect((await task.run({ text })).length).toBe(want);
    });

    test("returns string length", async () => {
      const task = new StringLengthTask();
      const result = await task.run({ text: "hello" });
      expect(result.length).toBe(5);
    });

    test("returns 0 for empty string", async () => {
      const task = new StringLengthTask();
      const result = await task.run({ text: "" });
      expect(result.length).toBe(0);
    });
  });

  describe("StringIncludesTask", () => {
    test("returns true when substring is found", async () => {
      const task = new StringIncludesTask();
      const result = await task.run({ text: "hello world", search: "world" });
      expect(result.included).toBe(true);
    });

    test("returns false when substring is not found", async () => {
      const task = new StringIncludesTask();
      const result = await task.run({ text: "hello world", search: "xyz" });
      expect(result.included).toBe(false);
    });
  });

  test("StringTemplateTask is gone in favour of TemplateTask", () => {
    expect("StringTemplateTask" in tasks).toBe(false);
    expect("TemplateTask" in tasks).toBe(true);
  });
});
