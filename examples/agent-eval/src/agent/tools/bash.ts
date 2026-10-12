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
/** The longest delay a Node timer holds; a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;
/** The longest timeout a command can ask for: the longest timer Node can set. */
export const MAX_TIMEOUT_SEC = Math.floor(MAX_TIMER_MS / 1000);

export interface CommandResult {
  readonly output: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly droppedBytes: number;
}

/**
 * Names of variables holding a credential: `*_API_KEY`, `*_TOKEN` (`HF_TOKEN`,
 * `ANTHROPIC_AUTH_TOKEN`), `*_SECRET`, `*_SECRET_KEY`, `*_ACCESS_KEY`, `*_PASSWORD`.
 */
const CREDENTIAL_ENV = /(?:_API_KEY|_TOKEN|_SECRET|_SECRET_KEY|_ACCESS_KEY|_PASSWORD)$/i;

/**
 * The environment a command runs in: the agent's own, minus the credentials it
 * reads its model's key from. The model writes the commands, so a key left here
 * is one `printenv` away from the transcript and the logs.
 */
export function shellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIAL_ENV.test(name)));
}

/**
 * Values that must never reach the transcript, read live so a test that sets
 * them late still scrubs. Only non-trivial values: redacting a one-character
 * value would mangle innocent output sharing it.
 */
function credentialValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = Object.entries(env)
    .filter(
      ([name, value]) => CREDENTIAL_ENV.test(name) && value !== undefined && value.length >= 8
    )
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
  return [...new Set(values)];
}

/**
 * Removes credential values from command output before it reaches the
 * transcript, the event log, or the spill file. Filtering the child's
 * environment is not enough on its own: the agent starts with the provider
 * keys in its own environment, and on Linux a same-UID command can read that
 * back out of `/proc/$PPID/environ` no matter what the child was given, so a
 * `printenv` and a `/proc` read exfiltrate alike. Scrubbing the output covers
 * both, whatever path the value took to get there.
 */
export function scrubCredentialValues(
  output: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  let scrubbed = output;
  for (const secret of credentialValues(env)) {
    if (scrubbed.includes(secret)) scrubbed = scrubbed.split(secret).join("[REDACTED]");
  }
  return scrubbed;
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
    // An abort that landed before the call would never fire the listener below.
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const child = spawn("bash", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: shellEnv(),
    });
    const chunks: Buffer[] = [];
    let held = 0;
    let dropped = 0;
    // The end of a command's output is where its failures and summaries are, so
    // past the cap the oldest bytes go, never the newest.
    const take = (chunk: Buffer): void => {
      chunks.push(chunk);
      held += chunk.length;
      while (held > MAX_CAPTURE_BYTES) {
        const excess = held - MAX_CAPTURE_BYTES;
        const first = chunks[0]!;
        if (first.length <= excess) {
          chunks.shift();
          held -= first.length;
          dropped += first.length;
        } else {
          chunks[0] = first.subarray(excess);
          held -= excess;
          dropped += excess;
        }
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);

    let timedOut = false;
    // Set once the command is told to stop. The command is over only when its
    // whole group is: a process it started can ignore SIGTERM and outlive the
    // shell, and returning while it still runs would let the next tool call
    // race it. So the result waits for the group to go, and sends SIGKILL to
    // whatever is left once the grace period is up.
    let stopped: Promise<void> | undefined;
    const stop = (): void => {
      if (child.pid === undefined || stopped !== undefined) return;
      const group = child.pid;
      try {
        process.kill(-group, "SIGTERM");
      } catch {
        // Already gone.
      }
      stopped = new Promise((done) => {
        const since = Date.now();
        const check = (): void => {
          if (!groupAlive(group)) return done();
          if (Date.now() - since >= KILL_GRACE_MS) {
            try {
              process.kill(-group, "SIGKILL");
            } catch {
              // Already gone.
            }
            return done();
          }
          setTimeout(check, 50);
        };
        check();
      });
    };
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      Math.min(timeoutMs, MAX_TIMER_MS)
    );
    const onAbort = (): void => stop();
    signal.addEventListener("abort", onAbort, { once: true });

    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
    // The command is over once the shell exits, so the timeout is too: it must
    // not fire during the drain and report a finished command as timed out.
    const finishOnceStopped = (code: number | null): void => {
      if (stopped === undefined) finish(code);
      else void stopped.then(() => finish(code));
    };
    child.on("exit", (code) => {
      clearTimeout(timer);
      setTimeout(() => finishOnceStopped(code), DRAIN_MS);
    });
    child.on("close", (code) => finishOnceStopped(code));
  });
}

/** Whether any process in a group is still there (a zombie counts until reaped). */
function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The timeout a command runs under: what was asked for, cut to the whole
 * seconds the task has left. The tool runs nothing with under a second left,
 * so the floor of one second never reaches past the deadline.
 */
export function commandTimeoutSec(
  requested: number,
  deadline: number | undefined,
  now: number
): { readonly sec: number; readonly capped: boolean } {
  if (deadline === undefined) return { sec: requested, capped: false };
  const left = Math.max(1, Math.floor((deadline - now) / 1000));
  return left < requested ? { sec: left, capped: true } : { sec: requested, capped: false };
}

export function createBashTool(context: CodingToolContext): ToolDefinition {
  return {
    name: "bash",
    description:
      "Run a bash command in the working directory and return its combined stdout and stderr. " +
      "Each call is a fresh shell: cd and exported variables do not carry over, so chain " +
      "commands with && when they depend on each other. Output is truncated to the last 2000 " +
      `lines or 50KB; the full output is saved to a file named in the result. Commands time out ` +
      `after ${context.defaultCommandTimeoutSec}s unless you pass a larger timeout (seconds), ` +
      "and never run past the time left for the task: run long jobs in the background and poll. " +
      "Do not start interactive programs.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        timeout: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TIMEOUT_SEC,
          description: "Timeout in seconds",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    requiresApproval: false,
    execute: async (input, { signal, deadline }) => {
      const command = requireString(input, "command");
      const requested = optionalInteger(input, "timeout") ?? context.defaultCommandTimeoutSec;
      if (requested < 1) {
        throw new ToolCallError(`"timeout" must be at least 1 second; the command was not run.`);
      }
      // A longer timer cannot be set; refused rather than silently shortened.
      if (requested > MAX_TIMEOUT_SEC) {
        throw new ToolCallError(
          `"timeout" can be at most ${MAX_TIMEOUT_SEC} seconds; the command was not run.`
        );
      }
      if (deadline !== undefined && deadline - Date.now() < 1000) {
        throw new ToolCallError(
          "No time is left for this task; the command was not run. Finish with what you have."
        );
      }
      const { sec: timeoutSec, capped } = commandTimeoutSec(requested, deadline, Date.now());
      const result = await runCommand(command, context.cwd, timeoutSec * 1000, signal);

      // Scrubbed before anything persists it: the transcript, the event log,
      // and the spill file below all derive from this string.
      const output = scrubCredentialValues(result.output);
      const tail = truncateTail(output);
      let text = tail.text;
      if (tail.truncated || result.droppedBytes > 0) {
        await mkdir(context.spillDir, { recursive: true });
        const spill = join(context.spillDir, `bash-${uuid4()}.log`);
        await writeFile(spill, output, "utf8");
        const lost =
          result.droppedBytes > 0 ? `, ${result.droppedBytes} earlier bytes discarded` : "";
        text =
          `[Output truncated: showing the last ${tail.keptLines} of ${tail.totalLines} lines` +
          `${tail.partialLine ? ", the first of them only its end" : ""}. ` +
          `Full output (${result.droppedBytes > 0 ? "last " : ""}${output.length} characters${lost}) saved to ${spill}]\n` +
          text;
      }
      if (text.length === 0) text = "(no output)";
      if (result.timedOut) {
        throw new ToolCallError(
          capped
            ? `${text}\n\nCommand was killed after ${timeoutSec}s, all the time left for this ` +
                "task. Finish with what you have."
            : `${text}\n\nCommand timed out after ${timeoutSec}s and was killed. ` +
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
