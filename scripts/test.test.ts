/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test } from "bun:test";

describe("scripts/test.ts", () => {
  test("unit bun dry-run omits integration files and empty argv entries", async () => {
    const proc = Bun.spawn(["bun", "scripts/test.ts", "unit", "bun", "--dry-run"], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain('"bun","test"');
    expect(stdout).not.toContain('""');
    expect(stdout).not.toContain(".integration.test.ts");
  });

  test("--changed without a kind still delegates to turbo run test", async () => {
    const proc = Bun.spawn(["bun", "scripts/test.ts", "--changed", "HEAD", "--dry-run"], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain('"turbo","run","test"');
    expect(stdout).toContain("--filter=...[HEAD]");
  });

  test("--changed with a kind does not hand the run to turbo run test", async () => {
    // CI jobs pass a kind (unit, integration, …) alongside --changed. If
    // --changed still short-circuits to `turbo run test`, those jobs run the
    // unit tier instead of their slice — rag/provider integration never runs,
    // or worse, a unit job's coverage is reported as the integration job's.
    const proc = Bun.spawn(["bun", "scripts/test.ts", "--changed", "HEAD", "unit", "--dry-run"], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).not.toContain('"turbo","run","test"');
  });

  test("provider-nodellama vitest dry-run disables file parallelism", async () => {
    const proc = Bun.spawn(
      ["bun", "scripts/test.ts", "integration", "provider-nodellama", "vitest", "--dry-run"],
      {
        cwd: import.meta.dir + "/..",
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("--no-file-parallelism");
  });

  /**
   * Coverage is opt-in by name, not "any CI run". Every job in the blocking
   * workflow runs one slice of the suite, so a per-job number is only
   * meaningful once the fragments are stitched back together — and the
   * stitching (an artifact per job, a merge job, a cleanup job) was paid for on
   * every push. The nightly workflow sets `WORKGLOW_COVERAGE` and runs the
   * suite in one job instead.
   */
  describe("coverage flag", () => {
    async function vitestDryRun(
      env: Record<string, string>
    ): Promise<{ readonly stdout: string; readonly stderr: string }> {
      const proc = Bun.spawn(["bun", "scripts/test.ts", "unit", "vitest", "--dry-run"], {
        cwd: import.meta.dir + "/..",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, WORKGLOW_COVERAGE: "", WORKGLOW_TEST_TARGET: "", ...env },
      });
      // stderr is drained, not merely piped: an undrained pipe deadlocks the
      // child once it fills, and a non-zero exit with the message thrown away
      // is a bare "expected 1 to be 0".
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) throw new Error(`scripts/test.ts exited ${exitCode}: ${stderr}`);
      return { stdout, stderr };
    }

    test("is off unless asked for, CI or not", async () => {
      expect((await vitestDryRun({ CI: "true" })).stdout).not.toContain('"--coverage"');
    });

    test("is on when the nightly job asks for it", async () => {
      expect((await vitestDryRun({ WORKGLOW_COVERAGE: "1" })).stdout).toContain('"--coverage"');
      expect((await vitestDryRun({ WORKGLOW_COVERAGE: "0" })).stdout).not.toContain('"--coverage"');
    });

    test("is refused against the dist target, and says so", async () => {
      // A dist run measures the bundles, not the sources the denominator names,
      // so every source file would be reported at 0%. Dropping the flag without
      // a word leaves the caller who asked for coverage by name reading an
      // empty `coverage/` for the reason.
      const { stdout, stderr } = await vitestDryRun({
        WORKGLOW_COVERAGE: "1",
        WORKGLOW_TEST_TARGET: "dist",
      });
      expect(stdout).not.toContain('"--coverage"');
      expect(stderr).toContain("WORKGLOW_COVERAGE is set but");
    });
  });

  /**
   * `shardFiles` is tested over lists in `testShards.test.ts`; what is tested
   * here is the wiring, over the real selection the CI jobs pass. The failure
   * this catches is the silent one: a shard that resolves to more or fewer
   * files than it should still passes, and four green jobs then report a suite
   * that was never run whole.
   */
  describe("--shard", () => {
    async function unitShardFiles(shardArg: readonly string[]): Promise<string[]> {
      const proc = Bun.spawn(
        ["bun", "scripts/test.ts", "vitest", "unit", ...shardArg, "--dry-run"],
        { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" }
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) throw new Error(`scripts/test.ts exited ${exitCode}: ${stderr}`);
      const line = stdout.split("\n").find((l) => l.startsWith("["));
      if (line === undefined) throw new Error(`no runner command in output:\n${stdout}`);
      // ["npx","vitest","run", ...files] — the flags carry no ".test.ts".
      return (JSON.parse(line) as string[]).filter((a) => a.endsWith(".test.ts"));
    }

    test("the four shards CI runs are exactly the unsharded selection", async () => {
      const [whole, ...pieces] = await Promise.all([
        unitShardFiles([]),
        unitShardFiles(["--shard", "1/4"]),
        unitShardFiles(["--shard", "2/4"]),
        unitShardFiles(["--shard", "3/4"]),
        unitShardFiles(["--shard", "4/4"]),
      ]);
      expect(whole.length).toBeGreaterThan(0);
      // Sorted-and-equal covers both halves at once: a file in two shards makes
      // the union longer than the whole, and a file in none makes it shorter.
      expect(pieces.flat().sort()).toEqual([...whole].sort());
      const sizes = pieces.map((p) => p.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }, 60_000);

    test("is consumed as an option, not read as a section", async () => {
      const proc = Bun.spawn(
        ["bun", "scripts/test.ts", "vitest", "unit", "--shard", "2/4", "--dry-run"],
        { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" }
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("shard 2/4");
    });

    test("refuses a malformed value instead of running a slice as the whole", async () => {
      const proc = Bun.spawn(["bun", "scripts/test.ts", "vitest", "unit", "--shard", "5/4"], {
        cwd: import.meta.dir + "/..",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("--shard index must be between 1 and 4");
    });
  });
});
