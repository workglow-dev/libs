/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolDefinition } from "@workglow/ai";
import { ToolCallError } from "@workglow/ai";
import { stripAnsi } from "./ansi";
import type { SandboxPort, SandboxProcess } from "./sandboxPort";
import { resolveSandboxPath, SandboxPathError } from "./sandboxPort";

/** Programs the model may start. No shell is among them, so `a && b` is not a thing it can say. */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "ls",
  "cat",
  "mkdir",
  "rm",
  "mv",
  "cp",
  "touch",
  "pwd",
  "echo",
];

export interface SandboxToolOptions {
  readonly allowedCommands?: readonly string[] | undefined;
  /** Largest file `write_file` accepts, in bytes. */
  readonly maxFileBytes?: number | undefined;
  /** Characters of command output kept (the tail) and shown to the model. */
  readonly maxOutputChars?: number | undefined;
  /** Seconds a foreground command runs before it is killed. */
  readonly commandTimeoutSec?: number | undefined;
  /** Seconds to wait for a background server to start listening. */
  readonly serverReadyTimeoutSec?: number | undefined;
  /** Servers the model may leave running at once. */
  readonly maxBackgroundProcesses?: number | undefined;
  /** Told when a server inside the sandbox is ready, so a host can show it. */
  readonly onPreview?: ((url: string, port: number) => void) | undefined;
}

export interface SandboxTools {
  readonly tools: ToolDefinition[];
  /** Hears of each server that starts listening, across every run that uses these tools. */
  onPreview(listener: (url: string, port: number) => void): () => void;
  /** Kills every background process. Call when the sandbox is abandoned, not between turns. */
  dispose(): void;
}

const DEFAULTS = {
  maxFileBytes: 512 * 1024,
  maxOutputChars: 8_000,
  commandTimeoutSec: 90,
  serverReadyTimeoutSec: 45,
  maxBackgroundProcesses: 3,
} as const;

/** Past this a read is a dump, not a look at a file. */
const MAX_READ_CHARS = 40_000;
const MAX_LISTED_ENTRIES = 400;
const MAX_LISTED_DEPTH = 6;
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", ".git"]);

export interface SandboxListing {
  /** Paths under the root, directories with a trailing slash. */
  readonly lines: readonly string[];
  /** True when the entry cap or the depth limit left something out. */
  readonly truncated: boolean;
}

/**
 * The project tree, bounded in depth and entries so a deeply nested or huge
 * project (the model chooses the paths) cannot turn a listing into unbounded
 * `readdir` calls. Shared by the `list_files` tool and any UI showing the tree.
 */
export async function listSandboxFiles(port: SandboxPort, root = "."): Promise<SandboxListing> {
  const lines: string[] = [];
  let truncated = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = [...(await port.readdir(dir))].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (lines.length >= MAX_LISTED_ENTRIES) {
        truncated = true;
        return;
      }
      const full = dir === "." ? entry.name : `${dir}/${entry.name}`;
      lines.push(entry.isDirectory ? `${full}/` : full);
      if (entry.isDirectory && !SKIPPED_DIRECTORIES.has(entry.name)) {
        if (depth < MAX_LISTED_DEPTH) await walk(full, depth + 1);
        else truncated = true;
      }
    }
  };
  await walk(root, 0);
  return { lines, truncated };
}

function fail(message: string): never {
  throw new ToolCallError(message);
}

function stringArg(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") fail(`"${key}" must be a string`);
  return value;
}

function safePath(raw: string): string {
  try {
    return resolveSandboxPath(raw);
  } catch (error) {
    if (error instanceof SandboxPathError) fail(error.message);
    throw error;
  }
}

/** Keeps the tail: the error that ends an install is at the bottom. */
class TailBuffer {
  private text = "";
  private dropped = 0;
  constructor(private readonly max: number) {}

  append(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.max * 2) {
      const cut = this.text.length - this.max;
      this.dropped += cut;
      this.text = this.text.slice(cut);
    }
  }

  read(): string {
    const clean = stripAnsi(this.text);
    const tail = clean.length > this.max ? clean.slice(clean.length - this.max) : clean;
    const omitted = this.dropped + (clean.length - tail.length);
    return omitted > 0 ? `[… ${omitted} earlier characters omitted]\n${tail}` : tail;
  }
}

interface Pump {
  /** Settles when the stream ends. */
  readonly done: Promise<void>;
  /** Stops reading; for a process that was killed and may never close its stream. */
  stop(): void;
}

function pump(process: SandboxProcess, buffer: TailBuffer): Pump {
  const reader = process.output.getReader();
  const done = (async () => {
    try {
      for (;;) {
        const { done: ended, value } = await reader.read();
        if (ended) return;
        buffer.append(value);
      }
    } catch {
      // The stream errors when the process is killed; what was read is the output.
    }
  })();
  return { done, stop: () => void reader.cancel().catch(() => {}) };
}

function sleep(ms: number, signal: AbortSignal): Promise<"timeout" | "aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve("aborted");
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve("timeout");
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve("aborted");
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The tools the agent builds with. Each is a host function over a
 * {@link SandboxPort}: nothing the model asks for touches the page, the
 * network the page can reach, or the user's disk — only the sandbox. That is
 * why `approval: "never"` is sound for this agent where it would not be for a
 * shell on the host.
 */
export function createSandboxTools(
  port: SandboxPort,
  options: SandboxToolOptions = {}
): SandboxTools {
  const allowed = new Set(options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS);
  const maxFileBytes = options.maxFileBytes ?? DEFAULTS.maxFileBytes;
  const maxOutputChars = options.maxOutputChars ?? DEFAULTS.maxOutputChars;
  const commandTimeoutSec = options.commandTimeoutSec ?? DEFAULTS.commandTimeoutSec;
  const serverReadyTimeoutSec = options.serverReadyTimeoutSec ?? DEFAULTS.serverReadyTimeoutSec;
  const maxBackground = options.maxBackgroundProcesses ?? DEFAULTS.maxBackgroundProcesses;
  const background = new Set<SandboxProcess>();
  /** Background programs asked for whose spawn has not yet landed in `background`. */
  let startingServers = 0;
  /** Bumped by every stop, so a start that began before it can tell it was stopped. */
  let stopEpoch = 0;
  /** Settles when the background server being started, and those queued before it, are up. */
  let serverStartups: Promise<void> = Promise.resolve();
  const previewListeners = new Set<(url: string, port: number) => void>();
  if (options.onPreview) previewListeners.add(options.onPreview);

  const writeFile: ToolDefinition = {
    name: "write_file",
    description:
      "Create or overwrite a file in the project with the complete content given. " +
      "Parent directories are created. Paths are relative to the project root.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, e.g. src/app.js" },
        content: { type: "string", description: "The complete file content" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    requiresApproval: false,
    execute: async (input) => {
      const path = safePath(stringArg(input, "path"));
      const content = stringArg(input, "content");
      if (path === ".") fail("path names the project root, not a file");
      const bytes = new TextEncoder().encode(content).length;
      if (bytes > maxFileBytes) {
        fail(`file is ${bytes} bytes; the limit is ${maxFileBytes}. Split it into modules.`);
      }
      const slash = path.lastIndexOf("/");
      if (slash > 0) await port.mkdir(path.slice(0, slash));
      await port.writeFile(path, content);
      return `Wrote ${bytes} bytes to ${path}`;
    },
  };

  const readFile: ToolDefinition = {
    name: "read_file",
    description: "Read a text file from the project.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    requiresApproval: false,
    execute: async (input) => {
      const path = safePath(stringArg(input, "path"));
      let content: string;
      try {
        content = await port.readFile(path);
      } catch (error) {
        fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return content.length > MAX_READ_CHARS
        ? `${content.slice(0, MAX_READ_CHARS)}\n[… truncated, ${content.length} characters in all]`
        : content;
    },
  };

  const listFiles: ToolDefinition = {
    name: "list_files",
    description:
      "List the files and directories under a path, recursively. node_modules is not entered.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory relative to the project root; default the root",
        },
      },
      additionalProperties: false,
    },
    requiresApproval: false,
    execute: async (input) => {
      const root = safePath(typeof input.path === "string" ? input.path : ".");
      const { lines, truncated } = await listSandboxFiles(port, root).catch((error: unknown) =>
        fail(`cannot list ${root}: ${error instanceof Error ? error.message : String(error)}`)
      );
      if (lines.length === 0) return "(empty)";
      return truncated
        ? `${lines.join("\n")}\n[… listing cut short at ${MAX_LISTED_ENTRIES} entries or ${MAX_LISTED_DEPTH} levels deep]`
        : lines.join("\n");
    },
  };

  const runCommand: ToolDefinition = {
    name: "run_command",
    description:
      "Run a program inside the sandbox, in the project root. There is no shell: give the program " +
      "and its arguments separately, and chain steps with separate calls. " +
      `Allowed programs: ${[...allowed].join(", ")}. ` +
      "By default the call waits for the program to exit and returns its output and exit code. " +
      "For a server, set background: true; the call then returns once the server is listening, " +
      "with the preview URL the user will see.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Program name, e.g. npm" },
        args: {
          type: "array",
          items: { type: "string" },
          description: 'Arguments, e.g. ["install", "express"]',
        },
        background: {
          type: "boolean",
          description: "Leave the program running (a dev server) and return its preview URL",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    requiresApproval: false,
    execute: async (input, context) => {
      const command = stringArg(input, "command");
      if (!allowed.has(command)) {
        fail(`"${command}" is not available. Allowed: ${[...allowed].join(", ")}.`);
      }
      const rawArgs = input.args ?? [];
      if (!Array.isArray(rawArgs) || rawArgs.some((arg) => typeof arg !== "string")) {
        fail('"args" must be an array of strings');
      }
      const args = rawArgs as string[];
      const wantsBackground = input.background === true;
      // The slot is claimed here, with no await between the check and the claim, and
      // held until the process is registered in `background`: parallel tool calls
      // would otherwise all see room before any of them had spawned.
      if (wantsBackground && background.size + startingServers >= maxBackground) {
        fail(
          `${background.size + startingServers} servers are already running; the limit is ${maxBackground}.`
        );
      }
      const epoch = stopEpoch;
      let slotHeld = wantsBackground;
      if (slotHeld) startingServers++;
      const releaseSlot = (): void => {
        if (!slotHeld) return;
        slotHeld = false;
        startingServers--;
      };

      const buffer = new TailBuffer(maxOutputChars);
      const urls: string[] = [];
      let off: () => void = () => {};
      let releaseStartup: () => void = () => {};
      // Listening for the run's cancellation starts before the process does, or a
      // Stop clicked while it is starting is missed and the program outlives the run.
      const waiter = new AbortController();
      const stop = (): void => waiter.abort();
      const cleanup = (): void => {
        releaseSlot();
        releaseStartup();
        context.signal.removeEventListener("abort", stop);
        waiter.abort();
        off();
      };
      if (context.signal.aborted) {
        cleanup();
        fail("the run was cancelled before the program started");
      }
      context.signal.addEventListener("abort", stop, { once: true });
      if (wantsBackground) {
        // The container announces a listening port without saying whose it is, so only
        // one server starts at a time: an announcement during this startup is this one's.
        const prior = serverStartups;
        const mine = new Promise<void>((resolve) => (releaseStartup = resolve));
        serverStartups = Promise.all([prior, mine]).then(() => {});
        await prior;
        if (waiter.signal.aborted || stopEpoch !== epoch) {
          cleanup();
          return "[not started: the run was cancelled or stop_servers was called first]";
        }
      }
      off = port.onServerReady((serverPort, url) => {
        urls.push(url);
        for (const listener of previewListeners) listener(url, serverPort);
      });
      let process: SandboxProcess;
      try {
        process = await port.spawn(command, args);
      } catch (error) {
        cleanup();
        fail(`cannot start ${command}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (waiter.signal.aborted || (wantsBackground && stopEpoch !== epoch)) {
        process.kill();
        cleanup();
        return "[cancelled or stopped while the program was starting; it was killed]";
      }
      const pumped = pump(process, buffer);
      const exited = process.exit.then((code) => ({ code }));
      const budgetMs = (wantsBackground ? serverReadyTimeoutSec : commandTimeoutSec) * 1000;
      const deadlineMs =
        context.deadline === undefined
          ? budgetMs
          : Math.min(budgetMs, Math.max(0, context.deadline - Date.now()));

      try {
        if (!wantsBackground) {
          const result = await Promise.race([exited, sleep(deadlineMs, waiter.signal)]);
          if (typeof result === "string") {
            process.kill();
            pumped.stop();
            await pumped.done;
            const why =
              result === "aborted" ? "cancelled" : `still running after ${deadlineMs / 1000}s`;
            return `${buffer.read()}\n[killed: ${why}. For a server, call again with background: true.]`;
          }
          await pumped.done;
          return `${buffer.read()}\n[exit code ${result.code}]`;
        }

        // A server is done starting when it listens or when it dies trying.
        const ready = new Promise<"ready">((resolve) => {
          const poll = setInterval(() => {
            if (urls.length > 0) {
              clearInterval(poll);
              resolve("ready");
            }
          }, 100);
          waiter.signal.addEventListener("abort", () => clearInterval(poll), { once: true });
        });
        background.add(process);
        releaseSlot();
        void exited.finally(() => background.delete(process));
        const result = await Promise.race([ready, exited, sleep(deadlineMs, waiter.signal)]);
        if (result === "ready") {
          return `Server is running.\nPreview URL: ${urls[0]}\n\n${buffer.read()}`;
        }
        process.kill();
        background.delete(process);
        if (typeof result === "object") {
          return `${buffer.read()}\n[the program exited with code ${result.code} before listening on a port]`;
        }
        return `${buffer.read()}\n[no server was listening after ${deadlineMs / 1000}s; killed]`;
      } finally {
        cleanup();
      }
    },
  };

  const killBackground = (): number => {
    // Starts still queued or spawning count too: they see the new epoch and stand down.
    const count = background.size + startingServers;
    stopEpoch++;
    for (const process of background) process.kill();
    background.clear();
    return count;
  };

  const stopServers: ToolDefinition = {
    name: "stop_servers",
    description:
      "Stop every server left running by run_command. Servers keep running between your turns " +
      "so the user's preview stays live; stop them before starting a server again on the same port.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requiresApproval: false,
    execute: async () => `Stopped ${killBackground()} server(s).`,
  };

  return {
    tools: [writeFile, readFile, listFiles, runCommand, stopServers],
    onPreview(listener): () => void {
      previewListeners.add(listener);
      return () => void previewListeners.delete(listener);
    },
    dispose(): void {
      killBackground();
    },
  };
}
