/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// Import directly from source to avoid ambiguous export issue
import { Entitlements, TaskEntitlementError, TaskInvalidInputError } from "@workglow/task-graph";
import { FileLoaderTask } from "@workglow/tasks";
import { setLogger } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, parse } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

describe("FileLoaderTask (server - local files)", () => {
  let logger = getTestingLogger();
  setLogger(logger);
  let testDir: string;

  beforeEach(() => {
    // Create a temporary directory for test files
    testDir = join(tmpdir(), `fileloader-test-${Date.now()}`);
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    // The task realpaths a local path before declaring or opening it, and on
    // macOS the temp dir is a symlink (/var/folders -> /private/var/folders).
    // Compare against the real path so the expectations match what the task sees.
    testDir = realpathSync(testDir);
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("loads text file from filesystem", async () => {
    const content = "Hello, World!";
    const filePath = join(testDir, "test.txt");
    writeFileSync(filePath, content, "utf-8");

    const task = new FileLoaderTask({
      roots: [testDir],
      defaults: { url: `file://${filePath}`, format: "text" },
    });
    const result = await task.run();

    expect(result.text).toBe(content);
    expect(result.metadata.format).toBe("text");
    expect(result.metadata.mimeType).toBe("text/plain");
    expect(result.metadata.size).toBe(content.length);
    expect(result.metadata.title).toBe("test.txt");
    // Server version strips file:// prefix, so URL should be the file path
    expect(result.metadata.url).toBe(filePath);
  });

  test("loads text file with file:// URL", async () => {
    const content = "File URL test";
    const filePath = join(testDir, "test.txt");
    writeFileSync(filePath, content, "utf-8");

    const task = new FileLoaderTask({
      roots: [testDir],
      defaults: { url: `file://${filePath}`, format: "text" },
    });
    const result = await task.run();

    expect(result.text).toBe(content);
    expect(result.metadata.format).toBe("text");
  });

  test("loads markdown file with auto-detection", async () => {
    const content = "# Hello\n\nThis is markdown.";
    const filePath = join(testDir, "test.md");
    writeFileSync(filePath, content, "utf-8");

    const task = new FileLoaderTask({
      roots: [testDir],
      defaults: { url: `file://${filePath}`, format: "auto" },
    });
    const result = await task.run();

    expect(result.text).toBe(content);
    expect(result.metadata.format).toBe("markdown");
    expect(result.metadata.mimeType).toBe("text/markdown");
  });

  test("loads JSON file and parses content", async () => {
    const jsonData = { name: "Test", value: 42, nested: { key: "value" } };
    const filePath = join(testDir, "test.json");
    writeFileSync(filePath, JSON.stringify(jsonData), "utf-8");

    const task = new FileLoaderTask({
      roots: [testDir],
      defaults: { url: `file://${filePath}`, format: "auto" },
    });
    const result = await task.run();

    expect(result.json).toEqual(jsonData);
    expect(result.metadata.format).toBe("json");
    expect(result.metadata.mimeType).toBe("application/json");
  });

  test("throws error for invalid JSON", async () => {
    const invalidJson = "{ invalid json }";
    const filePath = join(testDir, "invalid.json");
    writeFileSync(filePath, invalidJson, "utf-8");

    const task = new FileLoaderTask({
      roots: [testDir],
      defaults: { url: `file://${filePath}`, format: "json" },
    });

    await expect(task.run()).rejects.toThrow(
      /Failed to parse JSON|JSON Parse error|Expected property name or '\}' in JSON/
    );
  });

  test("loads CSV file and parses to array of objects", async () => {
    const csvContent = `name,age,city
John,30,New York
Jane,25,London
Bob,35,Paris`;
    const filePath = join(testDir, "test.csv");
    writeFileSync(filePath, csvContent, "utf-8");

    const task = new FileLoaderTask({
      roots: [testDir],
      defaults: { url: `file://${filePath}`, format: "auto" },
    });
    const result = await task.run();

    expect(result.metadata.format).toBe("csv");
    expect(result.metadata.mimeType).toBe("text/csv");
    const csvData = result.csv;
    expect(csvData).toHaveLength(3);
    expect(csvData![0]).toEqual({ name: "John", age: "30", city: "New York" });
    expect(csvData![1]).toEqual({ name: "Jane", age: "25", city: "London" });
    expect(csvData![2]).toEqual({ name: "Bob", age: "35", city: "Paris" });
  });

  test("handles CSV with quoted values", async () => {
    const csvContent = `name,description,price
"Product A","Contains, commas",10.99
"Product B","Has ""quotes""",20.50`;
    const filePath = join(testDir, "products.csv");
    writeFileSync(filePath, csvContent, "utf-8");

    const task = new FileLoaderTask({ roots: [testDir], defaults: { url: `file://${filePath}` } });
    const result = await task.run();

    expect(result.csv).toHaveLength(2);
    expect(result.csv![0]).toEqual({
      name: "Product A",
      description: "Contains, commas",
      price: "10.99",
    });
    expect(result.csv![1]).toEqual({
      name: "Product B",
      description: 'Has "quotes"',
      price: "20.50",
    });
  });

  test("loads HTML file with auto-detection", async () => {
    const htmlContent = "<html><body><h1>Hello</h1></body></html>";
    const filePath = join(testDir, "test.html");
    writeFileSync(filePath, htmlContent, "utf-8");

    const task = new FileLoaderTask({
      roots: [testDir],
      defaults: { url: `file://${filePath}`, format: "auto" },
    });
    const result = await task.run();

    expect(result.text).toBe(htmlContent);
    expect(result.metadata.format).toBe("html");
    expect(result.metadata.mimeType).toBe("text/html");
  });

  test("loads HTML file with .htm extension", async () => {
    const htmlContent = "<html><body><p>Test</p></body></html>";
    const filePath = join(testDir, "test.htm");
    writeFileSync(filePath, htmlContent, "utf-8");

    const task = new FileLoaderTask({
      roots: [testDir],
      defaults: { url: `file://${filePath}`, format: "auto" },
    });
    const result = await task.run();

    expect(result.metadata.format).toBe("html");
    expect(result.metadata.mimeType).toBe("text/html");
  });

  test("loads image file and converts to base64", async () => {
    // Create a simple PNG-like binary file
    const imageData = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
    const filePath = join(testDir, "test.png");
    writeFileSync(filePath, imageData);

    const task = new FileLoaderTask({
      roots: [testDir],
      defaults: { url: `file://${filePath}`, format: "auto" },
    });
    const result = await task.run();

    expect(result.image).toContain("data:image/png;base64,");
    expect(result.metadata.format).toBe("image");
    expect(result.metadata.mimeType).toBe("image/png");
    expect(result.metadata.size).toBe(imageData.length);
  });

  test("detects image format from different extensions", async () => {
    const extensions = [
      { ext: "jpg", mime: "image/jpeg" },
      { ext: "jpeg", mime: "image/jpeg" },
      { ext: "png", mime: "image/png" },
      { ext: "gif", mime: "image/gif" },
      { ext: "webp", mime: "image/webp" },
      { ext: "bmp", mime: "image/bmp" },
      { ext: "svg", mime: "image/svg+xml" },
      { ext: "ico", mime: "image/x-icon" },
    ];

    for (const { ext, mime } of extensions) {
      const imageData = Buffer.from([1, 2, 3, 4, 5]);
      const filePath = join(testDir, `test.${ext}`);
      writeFileSync(filePath, imageData);

      const task = new FileLoaderTask({
        roots: [testDir],
        defaults: { url: `file://${filePath}`, format: "auto" },
      });
      const result = await task.run();

      expect(result.metadata.format).toBe("image");
      expect(result.metadata.mimeType).toBe(mime);
      expect(result.image).toContain("data:");
      expect(result.image).toContain("base64");
    }
  });

  test("loads PDF file and converts to base64", async () => {
    // Create a simple PDF-like binary file
    const pdfData = Buffer.from([37, 80, 68, 70, 45, 49, 46, 52]);
    const filePath = join(testDir, "test.pdf");
    writeFileSync(filePath, pdfData);

    const task = new FileLoaderTask({
      roots: [testDir],
      defaults: { url: `file://${filePath}`, format: "auto" },
    });
    const result = await task.run();

    expect(result.pdf).toContain("data:application/pdf;base64,");
    expect(result.metadata.format).toBe("pdf");
    expect(result.metadata.mimeType).toBe("application/pdf");
    expect(result.metadata.size).toBe(pdfData.length);
  });

  test("handles explicit format override", async () => {
    const textContent = "This is actually text";
    const filePath = join(testDir, "data.json");
    writeFileSync(filePath, textContent, "utf-8");

    // Even though file extension is .json, force it as text
    const task = new FileLoaderTask({
      roots: [testDir],
      defaults: { url: `file://${filePath}`, format: "text" },
    });
    const result = await task.run();

    expect(result.metadata.format).toBe("text");
    expect(result.text).toBe(textContent);
  });

  test("handles empty CSV correctly", async () => {
    const csvContent = "header1,header2\n";
    const filePath = join(testDir, "empty.csv");
    writeFileSync(filePath, csvContent, "utf-8");

    const task = new FileLoaderTask({ roots: [testDir], defaults: { url: `file://${filePath}` } });
    const result = await task.run();

    expect(result.csv).toEqual([]);
  });

  test("case-insensitive file extension detection", async () => {
    const jsonData = { test: "value" };
    const filePath = join(testDir, "TEST.JSON");
    writeFileSync(filePath, JSON.stringify(jsonData), "utf-8");

    const task = new FileLoaderTask({
      roots: [testDir],
      defaults: { url: `file://${filePath}`, format: "auto" },
    });
    const result = await task.run();

    expect(result.metadata.format).toBe("json");
    expect(result.json).toEqual(jsonData);
  });

  test("defaults to text for unknown file extensions", async () => {
    const content = "Unknown file content";
    const filePath = join(testDir, "file.xyz");
    writeFileSync(filePath, content, "utf-8");

    const task = new FileLoaderTask({
      roots: [testDir],
      defaults: { url: `file://${filePath}`, format: "auto" },
    });
    const result = await task.run();

    expect(result.metadata.format).toBe("text");
    expect(result.text).toBe(content);
  });

  test("handles CSV with empty fields", async () => {
    const csvContent = `name,age,city
John,,New York
,25,
Bob,35,`;
    const filePath = join(testDir, "sparse.csv");
    writeFileSync(filePath, csvContent, "utf-8");

    const task = new FileLoaderTask({ roots: [testDir], defaults: { url: `file://${filePath}` } });
    const result = await task.run();

    expect(result.csv).toHaveLength(3);
    expect(result.csv![0]).toEqual({ name: "John", age: "", city: "New York" });
    expect(result.csv![1]).toEqual({ name: "", age: "25", city: "" });
    expect(result.csv![2]).toEqual({ name: "Bob", age: "35", city: "" });
  });

  test("metadata includes all required fields", async () => {
    const content = "test content";
    const filePath = join(testDir, "file.txt");
    writeFileSync(filePath, content, "utf-8");

    const task = new FileLoaderTask({
      roots: [testDir],
      defaults: { url: `file://${filePath}`, format: "text" },
    });
    const result = await task.run();

    expect(result.metadata).toHaveProperty("url", filePath);
    expect(result.metadata).toHaveProperty("format", "text");
    expect(result.metadata).toHaveProperty("size");
    expect(result.metadata).toHaveProperty("title", "file.txt");
    expect(result.metadata).toHaveProperty("mimeType", "text/plain");
  });

  test("handles complex nested JSON", async () => {
    const jsonData = {
      users: [
        { id: 1, name: "Alice", tags: ["admin", "user"] },
        { id: 2, name: "Bob", tags: ["user"] },
      ],
      metadata: {
        version: "1.0",
        created: "2025-01-01",
      },
    };
    const filePath = join(testDir, "complex.json");
    writeFileSync(filePath, JSON.stringify(jsonData), "utf-8");

    const task = new FileLoaderTask({ roots: [testDir], defaults: { url: `file://${filePath}` } });
    const result = await task.run();

    expect(result.json).toEqual(jsonData);
    const json = result.json as typeof jsonData;
    expect(json.users).toHaveLength(2);
    expect(json.users[0].tags).toContain("admin");
  });

  test("handles files with special characters in path", async () => {
    const content = "Special content";
    const specialDir = join(testDir, "special-dir");
    if (!existsSync(specialDir)) {
      mkdirSync(specialDir, { recursive: true });
    }
    const filePath = join(specialDir, "file-name.txt");
    writeFileSync(filePath, content, "utf-8");

    const task = new FileLoaderTask({ roots: [testDir], defaults: { url: `file://${filePath}` } });
    const result = await task.run();

    expect(result.text).toBe(content);
    expect(result.metadata.title).toBe("file-name.txt");
  });

  test("handles large CSV file", async () => {
    const rows = 1000;
    let csvContent = "id,name,value\n";
    for (let i = 1; i <= rows; i++) {
      csvContent += `${i},Name${i},Value${i}\n`;
    }
    const filePath = join(testDir, "large.csv");
    writeFileSync(filePath, csvContent, "utf-8");

    const task = new FileLoaderTask({ roots: [testDir], defaults: { url: `file://${filePath}` } });
    const result = await task.run();

    expect(result.csv).toHaveLength(rows);
    expect(result.csv![0]).toEqual({ id: "1", name: "Name1", value: "Value1" });
    expect(result.csv![rows - 1]).toEqual({
      id: rows.toString(),
      name: `Name${rows}`,
      value: `Value${rows}`,
    });
  });

  test("binary data is properly encoded in base64", async () => {
    // Create binary data with all byte values
    const binaryData = Buffer.from([0, 1, 2, 255, 254, 253]);
    const filePath = join(testDir, "binary.png");
    writeFileSync(filePath, binaryData);

    const task = new FileLoaderTask({ roots: [testDir], defaults: { url: `file://${filePath}` } });
    const result = await task.run();

    expect(result.image).toContain("data:image/png;base64,");
    // Decode and verify
    const base64Data = result.image!.split(",")[1];
    const decoded = Buffer.from(base64Data, "base64");
    expect(decoded).toEqual(binaryData);
  });

  test("updates progress during file loading", async () => {
    const content = "Test content";
    const filePath = join(testDir, "progress.txt");
    writeFileSync(filePath, content, "utf-8");

    const task = new FileLoaderTask({ roots: [testDir] });

    // Mock the task runner's updateProgress by accessing the task's progress property
    // Note: Progress updates happen internally via context.updateProgress
    // This test verifies the task completes successfully
    const result = await task.run({ url: `file://${filePath}` });

    expect(result.text).toBe(content);
    // Progress updates are internal to the task execution context
  });

  test("handles CSV with Windows line endings", async () => {
    const csvContent = "name,age\r\nJohn,30\r\nJane,25";
    const filePath = join(testDir, "windows.csv");
    writeFileSync(filePath, csvContent, "utf-8");

    const task = new FileLoaderTask({ roots: [testDir] });
    const result = await task.run({ url: `file://${filePath}` });

    expect(result.csv).toHaveLength(2);
    expect(result.csv![0]).toEqual({ name: "John", age: "30" });
    expect(result.csv![1]).toEqual({ name: "Jane", age: "25" });
  });

  test("handles CSV with mixed line endings", async () => {
    const csvContent = "name,age\nJohn,30\r\nJane,25";
    const filePath = join(testDir, "mixed.csv");
    writeFileSync(filePath, csvContent, "utf-8");

    const task = new FileLoaderTask({ roots: [testDir] });
    const result = await task.run({ url: `file://${filePath}` });

    expect(result.csv).toHaveLength(2);
  });

  test("parses markdown frontmatter from file", async () => {
    const content = `---
title: Hello World
date: 2025-01-15
draft: false
tags:
  - javascript
  - typescript
---

# Hello World

This is the body.`;
    const filePath = join(testDir, "frontmatter.md");
    writeFileSync(filePath, content, "utf-8");

    const task = new FileLoaderTask({ roots: [testDir] });
    const result = await task.run({ url: `file://${filePath}`, format: "auto" });

    expect(result.metadata.format).toBe("markdown");
    expect(result.frontmatter).toEqual({
      title: "Hello World",
      date: "2025-01-15",
      draft: false,
      tags: ["javascript", "typescript"],
    });
    expect(result.text).toBe("# Hello World\n\nThis is the body.");
  });

  test("returns undefined frontmatter for markdown without frontmatter", async () => {
    const content = "# Hello\n\nNo frontmatter here.";
    const filePath = join(testDir, "no-frontmatter.md");
    writeFileSync(filePath, content, "utf-8");

    const task = new FileLoaderTask({
      roots: [testDir],
      defaults: { url: `file://${filePath}`, format: "auto" },
    });
    const result = await task.run();

    expect(result.frontmatter).toBeUndefined();
    expect(result.text).toBe(content);
  });

  test("parses MDX frontmatter with auto-detection", async () => {
    const content = `---
title: Component Page
layout: docs
---

import { Button } from './Button';
import { setLogger } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";

# Component Page`;
    const filePath = join(testDir, "page.mdx");
    writeFileSync(filePath, content, "utf-8");

    const task = new FileLoaderTask({
      roots: [testDir],
      defaults: { url: `file://${filePath}`, format: "auto" },
    });
    const result = await task.run();

    expect(result.metadata.format).toBe("markdown");
    expect(result.frontmatter).toEqual({
      title: "Component Page",
      layout: "docs",
    });
    expect(result.text).toContain("import { Button }");
  });

  test("parses frontmatter with various value types", async () => {
    const content = `---
string_val: hello
number_int: 42
number_float: 3.14
bool_true: true
bool_false: false
null_val: null
quoted: "quoted value"
single_quoted: 'single quoted'
---

Body content.`;
    const filePath = join(testDir, "types.md");
    writeFileSync(filePath, content, "utf-8");

    const task = new FileLoaderTask({ roots: [testDir] });
    const result = await task.run({ url: `file://${filePath}` });

    expect(result.frontmatter).toEqual({
      string_val: "hello",
      number_int: 42,
      number_float: 3.14,
      bool_true: true,
      bool_false: false,
      null_val: null,
      quoted: "quoted value",
      single_quoted: "single quoted",
    });
  });

  test("returns undefined frontmatter for non-markdown text files", async () => {
    const content = "---\ntitle: Not Parsed\n---\nBody";
    const filePath = join(testDir, "test.txt");
    writeFileSync(filePath, content, "utf-8");

    const task = new FileLoaderTask({ roots: [testDir] });
    const result = await task.run({ url: `file://${filePath}`, format: "text" });

    expect(result.frontmatter).toBeUndefined();
    expect(result.text).toBe(content);
  });

  test("parses frontmatter with nested objects", async () => {
    const content = `---
title: Nested Test
author:
  name: John Doe
  email: john@example.com
---

Body.`;
    const filePath = join(testDir, "nested.md");
    writeFileSync(filePath, content, "utf-8");

    const task = new FileLoaderTask({ roots: [testDir] });
    const result = await task.run({ url: `file://${filePath}` });

    expect(result.frontmatter).toEqual({
      title: "Nested Test",
      author: {
        name: "John Doe",
        email: "john@example.com",
      },
    });
  });

  test("handles markdown with .markdown extension", async () => {
    const content = "# Title\n\nContent";
    const filePath = join(testDir, "test.markdown");
    writeFileSync(filePath, content, "utf-8");

    const task = new FileLoaderTask({ roots: [testDir] });
    const result = await task.run({ url: `file://${filePath}`, format: "auto" });

    expect(result.metadata.format).toBe("markdown");
    expect(result.metadata.mimeType).toBe("text/markdown");
    expect(result.text).toBe(content);
  });

  /**
   * This task was the worst of the three server file tasks: it declared no
   * entitlement at all, honoured no roots, and reached the filesystem by
   * `url.slice(7)` — which neither percent-decodes nor rejects a `file://`
   * host. It now runs the same resolver the grep and sed tasks do.
   */
  describe("local path containment", () => {
    test("refuses a path outside the cwd when no roots are configured", async () => {
      const filePath = join(testDir, "secret.txt");
      writeFileSync(filePath, "classified", "utf-8");

      const run = new FileLoaderTask({ defaults: { url: filePath, format: "text" } }).run();

      await expect(run).rejects.toThrow(TaskEntitlementError);
      await expect(run).rejects.toThrow(process.cwd());
    });

    test("refuses a path outside the configured roots", async () => {
      const outside = join(tmpdir(), `fileloader-outside-${Date.now()}.txt`);
      writeFileSync(outside, "classified", "utf-8");

      try {
        await expect(
          new FileLoaderTask({
            roots: [testDir],
            defaults: { url: outside, format: "text" },
          }).run()
        ).rejects.toThrow(TaskEntitlementError);
      } finally {
        rmSync(outside, { force: true });
      }
    });

    /**
     * Containment runs AFTER `realpathSync`, so a link sitting inside the root
     * cannot be used to read its target outside one.
     */
    test("refuses a symlink that escapes the configured roots", async () => {
      const link = join(testDir, "escape.txt");
      symlinkSync("/etc/passwd", link);

      await expect(
        new FileLoaderTask({
          roots: [testDir],
          defaults: { url: link, format: "text" },
        }).run()
      ).rejects.toThrow(TaskEntitlementError);
    });

    // A filesystem root already ends in its separator; adding another made `//` the
    // prefix every path was checked against, so a root of `/` contained nothing.
    test("reads a file under a root configured as the filesystem root", async () => {
      const filePath = join(testDir, "rooted.txt");
      writeFileSync(filePath, "under /", "utf-8");

      const result = await new FileLoaderTask({
        roots: [parse(testDir).root],
        defaults: { url: filePath, format: "text" },
      }).run();

      expect(result.text).toBe("under /");
    });

    test("allowAnyRoot restores the unrestricted read", async () => {
      const filePath = join(testDir, "open.txt");
      writeFileSync(filePath, "readable", "utf-8");

      const result = await new FileLoaderTask({
        allowAnyRoot: true,
        defaults: { url: filePath, format: "text" },
      }).run();

      expect(result.text).toBe("readable");
    });

    /**
     * `slice(7)` left the path percent-encoded, so a name with a space or a
     * `%` addressed a file that does not exist.
     */
    test("parses file:// URLs rather than slicing the scheme", async () => {
      const filePath = join(testDir, "a b%c.txt");
      writeFileSync(filePath, "decoded", "utf-8");

      const result = await new FileLoaderTask({
        roots: [testDir],
        defaults: { url: `file://${testDir}/a%20b%25c.txt`, format: "text" },
      }).run();

      expect(result.text).toBe("decoded");
    });

    test("rejects a file:// URL carrying a remote host", async () => {
      await expect(
        new FileLoaderTask({
          allowAnyRoot: true,
          defaults: { url: "file://evil.example/etc/passwd", format: "text" },
        }).run()
      ).rejects.toThrow(TaskInvalidInputError);
    });

    test("declares filesystem:read scoped to the resolved path", () => {
      const filePath = join(testDir, "declared.txt");
      writeFileSync(filePath, "content", "utf-8");

      const declared = new FileLoaderTask({
        roots: [testDir],
        defaults: { url: `file://${filePath}`, format: "text" },
      }).entitlements().entitlements;

      expect(declared.map((entitlement) => entitlement.id)).toEqual([Entitlements.FILESYSTEM_READ]);
      expect(declared[0].resources).toEqual([filePath]);
    });

    test("declares no filesystem:read for an http url", () => {
      const declared = new FileLoaderTask({
        defaults: { url: "https://example.com/data.json" },
      }).entitlements().entitlements;

      expect(declared.map((entitlement) => entitlement.id)).not.toContain(
        Entitlements.FILESYSTEM_READ
      );
    });
  });
});
