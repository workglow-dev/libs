/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFile, isAtomicWriteTempFile } from "../atomicWriteFile";

describe("atomicWriteFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "atomic-write-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes strings, bytes and streams and reports the byte count", async () => {
    const file = path.join(dir, "a.json");
    expect(await atomicWriteFile(file, "héllo")).toBe(6);
    expect(readFileSync(file, "utf8")).toBe("héllo");

    expect(await atomicWriteFile(file, new Uint8Array([1, 2, 3]))).toBe(3);
    expect([...readFileSync(file)]).toEqual([1, 2, 3]);

    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([4]);
      yield new Uint8Array([5, 6]);
    }
    expect(await atomicWriteFile(file, chunks())).toBe(3);
    expect([...readFileSync(file)]).toEqual([4, 5, 6]);
    expect(readdirSync(dir)).toEqual(["a.json"]);
  });

  // The crash a truncate-then-write loses data to: the new content stops
  // half way. The previous file must survive whole, with no temp file left.
  it("leaves the previous file intact when the write fails part way", async () => {
    const file = path.join(dir, "row.json");
    writeFileSync(file, '{"v":1}');
    async function* tornStream(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('{"v":');
      throw new Error("killed mid-write");
    }
    await expect(atomicWriteFile(file, tornStream())).rejects.toThrow("killed mid-write");
    expect(readFileSync(file, "utf8")).toBe('{"v":1}');
    expect(readdirSync(dir)).toEqual(["row.json"]);
  });

  it("names its temp files so listings can skip them", async () => {
    expect(isAtomicWriteTempFile("row.json.0c6e.tmp")).toBe(true);
    expect(isAtomicWriteTempFile("row.json")).toBe(false);
  });
});
