/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolDefinition } from "@workglow/ai";
import { ToolCallError } from "@workglow/ai";
import { uuid4 } from "@workglow/util";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodingToolContext } from "./context";
import { optionalInteger, requireString } from "./context";
import { truncateTail } from "./truncate";

/** Output held in memory per command; the rest is counted, not kept. */
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
/** Grace between SIGTERM and SIGKILL for a command being stopped. */
const KILL_GRACE_MS = 2000;
/** Wait after the shell exits for output still in the pipes. */
const DRAIN_MS = 250;

export interface CommandResult {
  readonly output: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly droppedBytes: number;
}

/**
 * Runs `command` under `bash -c` in its own process group, so a timeout or an
 * abort stops everything it started — a test runner's workers, a server it
 * backgrounded — rather than only the shell.
 */
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const chunks: Buffer[] = [];
    let held = 0;
    let dropped = 0;
    const take = (chunk: Buffer): void => {
      if (held + chunk.length <= MAX_CAPTURE_BYTES) {
        chunks.push(chunk);
        held += chunk.length;
      } else dropped += chunk.length;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // Already gone.
        }
      }, KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = (): void => stop();
    signal.addEventListener("abort", onAbort, { once: true });

    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      if (signal.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      resolve({
        output: Buffer.concat(chunks).toString("utf8"),
        exitCode: code,
        timedOut,
        droppedBytes: dropped,
      });
    };
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    // A command that backgrounds a process (`server &`) leaves it holding the
    // pipes, and "close" would wait for it. The shell exiting is the command
    // finishing; give the pipes a moment to drain, then stop listening.
    child.on("exit", (code) => setTimeout(() => finish(code), DRAIN_MS));
    child.on("close", (code) => finish(code));
  });
}

export function createBashTool(context: CodingToolContext): ToolDefinition {
  return {
    name: "bash",
    description:
      "Run a bash command in the working directory and return its combined stdout and stderr. " +
      "Each call is a fresh shell: cd and exported variables do not carry over, so chain " +
      "commands with && when they depend on each other. Output is truncated to the last 2000 " +
      `lines or 50KB; the full output is saved to a file named in the result. Commands time out ` +
      `after ${context.defaultCommandTimeoutSec}s unless you pass a larger timeout (seconds). ` +
      "Do not start interactive programs.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        timeout: { type: "integer", minimum: 1, description: "Timeout in seconds" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    requiresApproval: false,
    execute: async (input, { signal }) => {
      const command = requireString(input, "command");
      const timeoutSec = optionalInteger(input, "timeout") ?? context.defaultCommandTimeoutSec;
      const result = await runCommand(command, context.cwd, timeoutSec * 1000, signal);

      const tail = truncateTail(result.output);
      let text = tail.text;
      if (tail.truncated || result.droppedBytes > 0) {
        await mkdir(context.spillDir, { recursive: true });
        const spill = join(context.spillDir, `bash-${uuid4()}.log`);
        await writeFile(spill, result.output, "utf8");
        const lost =
          result.droppedBytes > 0 ? `, ${result.droppedBytes} bytes beyond that discarded` : "";
        text =
          `[Output truncated: showing the last ${tail.keptLines} of ${tail.totalLines} lines. ` +
          `Full output (first ${result.output.length} characters${lost}) saved to ${spill}]\n` +
          text;
      }
      if (text.length === 0) text = "(no output)";
      if (result.timedOut) {
        throw new ToolCallError(
          `${text}\n\nCommand timed out after ${timeoutSec}s and was killed. ` +
            "Pass a larger timeout, or run it in the background and poll."
        );
      }
      if (result.exitCode !== 0) {
        throw new ToolCallError(
          `${text}\n\nCommand exited with code ${result.exitCode ?? "unknown"}`
        );
      }
      return text;
    },
  };
}
