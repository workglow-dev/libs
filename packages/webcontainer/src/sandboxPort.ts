/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The slice of a WebContainer the agent's tools use. The tools are written
 * against this and not against `@webcontainer/api`, so they run unchanged
 * over a test double, and a host that embeds the agent (builder, embarc) can
 * back it with whatever sandbox it boots without the tools learning about it.
 *
 * Every path is relative to the sandbox root. The port never sees an absolute
 * or `..` path: {@link resolveSandboxPath} has already refused those.
 */
export interface SandboxPort {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Creates the directory and any missing parents. */
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<readonly SandboxEntry[]>;
  /** Starts a process with no shell: `args` reach the program as given. */
  spawn(command: string, args: readonly string[]): Promise<SandboxProcess>;
  /** Fires when a process inside the sandbox starts listening on a port. */
  onServerReady(listener: (port: number, url: string) => void): () => void;
}

export interface SandboxEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface SandboxProcess {
  /** Interleaved stdout and stderr. */
  readonly output: ReadableStream<string>;
  /** Resolves with the exit code. */
  readonly exit: Promise<number>;
  kill(): void;
}

/**
 * Turns a path the model wrote into one inside the sandbox root, or throws.
 *
 * A WebContainer already cannot reach the host, so this is not what keeps the
 * host safe. It keeps the model honest about where its project lives: a path
 * like `/etc/passwd` or `../../x` would otherwise silently address something
 * outside the project directory the preview serves, and the failure would be
 * a page that loads without the file the model thought it wrote.
 *
 * A leading `/` is read as the project root, because models write `/src/a.js`
 * for a project-relative file far more often than they mean a system path.
 */
export function resolveSandboxPath(input: string): string {
  if (input.includes("\0")) throw new SandboxPathError("path contains a NUL character");
  const segments: string[] = [];
  for (const segment of input.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.pop() === undefined) {
        throw new SandboxPathError(`path "${input}" leaves the project directory`);
      }
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? "." : segments.join("/");
}

export class SandboxPathError extends Error {
  override readonly name = "SandboxPathError";
}
