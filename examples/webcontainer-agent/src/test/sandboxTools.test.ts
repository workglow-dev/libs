/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolDefinition, ToolExecuteContext } from "@workglow/ai";
import { describe, expect, it } from "vitest";
import { resolveSandboxPath } from "../core/sandboxPort";
import type { SandboxEntry, SandboxPort, SandboxProcess } from "../core/sandboxPort";
import { createSandboxTools, listSandboxFiles } from "../core/sandboxTools";

interface FakeProgram {
  /** Chunks the program prints, then its exit code; `undefined` never exits. */
  readonly chunks: readonly string[];
  readonly exitCode: number | undefined;
  /** A port the program listens on, announced after it starts. */
  readonly listensOn?: number;
}

class FakeSandbox implements SandboxPort {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>(["."]);
  readonly killed: string[] = [];
  readonly spawned: Array<{ command: string; args: readonly string[] }> = [];
  private readonly listeners = new Set<(port: number, url: string) => void>();
  constructor(private readonly programs: Record<string, FakeProgram> = {}) {}

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error("ENOENT");
    return content;
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }
  async readdir(path: string): Promise<readonly SandboxEntry[]> {
    const prefix = path === "." ? "" : `${path}/`;
    const names = new Map<string, boolean>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf("/");
      names.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1);
    }
    return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
  }
  async spawn(command: string, args: readonly string[]): Promise<SandboxProcess> {
    this.spawned.push({ command, args });
    const program = this.programs[command] ?? { chunks: [], exitCode: 0 };
    let finish: (code: number) => void = () => {};
    const exit = new Promise<number>((resolve) => (finish = resolve));
    const output = new ReadableStream<string>({
      start: (controller) => {
        for (const chunk of program.chunks) controller.enqueue(chunk);
        if (program.exitCode !== undefined) {
          controller.close();
          finish(program.exitCode);
        }
      },
    });
    if (program.listensOn !== undefined) {
      const port = program.listensOn;
      queueMicrotask(() => {
        for (const listener of this.listeners) listener(port, `http://localhost:${port}`);
      });
    }
    return { output, exit, kill: () => void this.killed.push(command) };
  }
  onServerReady(listener: (port: number, url: string) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}

function context(): ToolExecuteContext {
  return { toolUseId: "t", signal: new AbortController().signal, deadline: undefined };
}

function tool(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (!found?.execute) throw new Error(`no tool ${name}`);
  return found;
}

async function call(
  tools: readonly ToolDefinition[],
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  return tool(tools, name).execute!(input, context());
}

describe("resolveSandboxPath", () => {
  it("reads a leading slash as the project root and normalizes", () => {
    expect(resolveSandboxPath("/src//a/./b.js")).toBe("src/a/b.js");
    expect(resolveSandboxPath("a\\b.js")).toBe("a/b.js");
    expect(resolveSandboxPath("")).toBe(".");
  });

  it("allows .. that stays inside and refuses one that leaves", () => {
    expect(resolveSandboxPath("a/b/../c")).toBe("a/c");
    expect(() => resolveSandboxPath("../x")).toThrow(/leaves the project/);
    expect(() => resolveSandboxPath("a/../../x")).toThrow(/leaves the project/);
    expect(() => resolveSandboxPath("a\0b")).toThrow(/NUL/);
  });
});

describe("file tools", () => {
  it("writes with parents, reads back, and lists", async () => {
    const sandbox = new FakeSandbox();
    const { tools } = createSandboxTools(sandbox);
    await call(tools, "write_file", { path: "/src/app.js", content: "x" });
    expect(sandbox.dirs.has("src")).toBe(true);
    expect(await call(tools, "read_file", { path: "src/app.js" })).toBe("x");
    expect(await call(tools, "list_files", {})).toBe("src/\nsrc/app.js");
  });

  it("refuses a path that escapes, an oversized file, and a missing file", async () => {
    const { tools } = createSandboxTools(new FakeSandbox(), { maxFileBytes: 4 });
    await expect(call(tools, "write_file", { path: "../x", content: "" })).rejects.toThrow(
      /leaves the project/
    );
    await expect(call(tools, "write_file", { path: "a", content: "12345" })).rejects.toThrow(
      /limit is 4/
    );
    await expect(call(tools, "read_file", { path: "nope" })).rejects.toThrow(/cannot read nope/);
  });
});

describe("listSandboxFiles", () => {
  it("stops at the entry cap and reports it", async () => {
    const sandbox = new FakeSandbox();
    for (let i = 0; i < 450; i++) sandbox.files.set(`f${String(i).padStart(3, "0")}`, "");
    const { lines, truncated } = await listSandboxFiles(sandbox);
    expect(lines).toHaveLength(400);
    expect(truncated).toBe(true);
  });

  it("reports truncation only when something was left out", async () => {
    const exact = new FakeSandbox();
    for (let i = 0; i < 400; i++) exact.files.set(`f${String(i).padStart(3, "0")}`, "");
    expect((await listSandboxFiles(exact)).truncated).toBe(false);
    const over = new FakeSandbox();
    for (let i = 0; i < 401; i++) over.files.set(`f${String(i).padStart(3, "0")}`, "");
    expect((await listSandboxFiles(over)).truncated).toBe(true);
  });

  it("does not follow a path nested deeper than the depth limit", async () => {
    const sandbox = new FakeSandbox();
    const deep = Array.from({ length: 20 }, (_, i) => `d${i}`).join("/");
    sandbox.files.set(`${deep}/leaf.txt`, "");
    const { lines } = await listSandboxFiles(sandbox);
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(lines).not.toContain(`${deep}/leaf.txt`);
    expect((await listSandboxFiles(sandbox)).truncated).toBe(true);
  });

  it("skips node_modules", async () => {
    const sandbox = new FakeSandbox();
    sandbox.files.set("node_modules/x/index.js", "");
    sandbox.files.set("a.js", "");
    expect((await listSandboxFiles(sandbox)).lines).toEqual(["a.js", "node_modules/"]);
  });
});

describe("run_command", () => {
  it("refuses a program that is not allowed, without starting anything", async () => {
    const sandbox = new FakeSandbox();
    const { tools } = createSandboxTools(sandbox);
    await expect(call(tools, "run_command", { command: "sh", args: ["-c", "ls"] })).rejects.toThrow(
      /"sh" is not available/
    );
    expect(sandbox.spawned).toEqual([]);
  });

  it("returns output and the exit code, with escapes stripped", async () => {
    const sandbox = new FakeSandbox({
      npm: { chunks: ["\u001b[32madded\u001b[0m 1 package\r\n"], exitCode: 0 },
    });
    const { tools } = createSandboxTools(sandbox);
    const result = await call(tools, "run_command", { command: "npm", args: ["install"] });
    expect(result).toBe("added 1 package\n\n[exit code 0]");
    expect(sandbox.spawned[0]).toEqual({ command: "npm", args: ["install"] });
  });

  it("keeps the tail of long output", async () => {
    const sandbox = new FakeSandbox({
      node: { chunks: ["a".repeat(100), "THE-END"], exitCode: 1 },
    });
    const { tools } = createSandboxTools(sandbox, { maxOutputChars: 20 });
    const result = (await call(tools, "run_command", { command: "node" })) as string;
    expect(result).toContain("earlier characters omitted");
    expect(result).toContain("THE-END");
    expect(result).toContain("[exit code 1]");
  });

  it("kills a foreground program that outlives its timeout", async () => {
    const sandbox = new FakeSandbox({ node: { chunks: ["starting"], exitCode: undefined } });
    const { tools } = createSandboxTools(sandbox, { commandTimeoutSec: 0.05 });
    const result = (await call(tools, "run_command", { command: "node" })) as string;
    expect(result).toContain("[killed: still running");
    expect(sandbox.killed).toEqual(["node"]);
  });

  it("returns the preview URL of a background server, leaves it running, and kills it on dispose", async () => {
    const sandbox = new FakeSandbox({
      npm: { chunks: ["listening"], exitCode: undefined, listensOn: 3000 },
    });
    const previews: string[] = [];
    const { tools, dispose } = createSandboxTools(sandbox, {
      onPreview: (url) => void previews.push(url),
    });
    const result = (await call(tools, "run_command", {
      command: "npm",
      args: ["start"],
      background: true,
    })) as string;
    expect(result).toContain("Preview URL: http://localhost:3000");
    expect(previews).toEqual(["http://localhost:3000"]);
    expect(sandbox.killed).toEqual([]);
    dispose();
    expect(sandbox.killed).toEqual(["npm"]);
  });

  it("reports a server that exits before it listens", async () => {
    const sandbox = new FakeSandbox({ node: { chunks: ["Error: boom"], exitCode: 1 } });
    const { tools } = createSandboxTools(sandbox);
    const result = (await call(tools, "run_command", {
      command: "node",
      background: true,
    })) as string;
    expect(result).toContain("Error: boom");
    expect(result).toContain("exited with code 1 before listening");
  });

  it("caps the servers left running", async () => {
    const sandbox = new FakeSandbox({
      node: { chunks: [], exitCode: undefined, listensOn: 3000 },
    });
    const { tools } = createSandboxTools(sandbox, { maxBackgroundProcesses: 1 });
    await call(tools, "run_command", { command: "node", background: true });
    await expect(call(tools, "run_command", { command: "node", background: true })).rejects.toThrow(
      /limit is 1/
    );
  });

  it("holds a background slot while the program is still spawning", async () => {
    const sandbox = new FakeSandbox({
      node: { chunks: [], exitCode: undefined, listensOn: 3000 },
    });
    const { tools } = createSandboxTools(sandbox, { maxBackgroundProcesses: 1 });
    const results = await Promise.allSettled([
      call(tools, "run_command", { command: "node", background: true }),
      call(tools, "run_command", { command: "node", background: true }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(sandbox.spawned).toHaveLength(1);
  });

  it("gives overlapping server starts their own preview URLs", async () => {
    const sandbox = new FakeSandbox({
      node: { chunks: [], exitCode: undefined, listensOn: 3000 },
      npm: { chunks: [], exitCode: undefined, listensOn: 3001 },
    });
    const { tools } = createSandboxTools(sandbox);
    const [a, b] = (await Promise.all([
      call(tools, "run_command", { command: "node", background: true }),
      call(tools, "run_command", { command: "npm", background: true }),
    ])) as string[];
    expect(a).toContain("http://localhost:3000");
    expect(b).toContain("http://localhost:3001");
    expect(b).not.toContain(":3000");
  });

  it("stop_servers also stops a background start that has not finished spawning", async () => {
    const sandbox = new FakeSandbox({
      node: { chunks: [], exitCode: undefined, listensOn: 3000 },
    });
    const slow = Object.create(sandbox) as FakeSandbox;
    slow.spawn = async (command, args) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return sandbox.spawn(command, args);
    };
    const { tools } = createSandboxTools(slow);
    const starting = call(tools, "run_command", { command: "node", background: true });
    await new Promise((resolve) => setTimeout(resolve, 5)); // now inside spawn
    expect(await call(tools, "stop_servers", {})).toBe("Stopped 1 server(s).");
    expect(await starting).toContain("cancelled or stopped while the program was starting");
    expect(sandbox.killed).toEqual(["node"]);
  });

  it("stop_servers stops a background start that has not reached spawn", async () => {
    const sandbox = new FakeSandbox({ node: { chunks: [], exitCode: undefined } });
    const { tools } = createSandboxTools(sandbox);
    const starting = call(tools, "run_command", { command: "node", background: true });
    expect(await call(tools, "stop_servers", {})).toBe("Stopped 1 server(s).");
    expect(await starting).toContain("not started");
    expect(sandbox.spawned).toEqual([]);
  });

  it("stop_servers kills the background servers and frees their slots", async () => {
    const sandbox = new FakeSandbox({
      node: { chunks: [], exitCode: undefined, listensOn: 3000 },
    });
    const { tools } = createSandboxTools(sandbox, { maxBackgroundProcesses: 1 });
    await call(tools, "run_command", { command: "node", background: true });
    expect(await call(tools, "stop_servers", {})).toBe("Stopped 1 server(s).");
    expect(sandbox.killed).toEqual(["node"]);
    await call(tools, "run_command", { command: "node", background: true });
  });

  it("kills a program whose run was cancelled while it was starting", async () => {
    const sandbox = new FakeSandbox({ node: { chunks: [], exitCode: undefined } });
    const slow = Object.create(sandbox) as FakeSandbox;
    slow.spawn = async (command, args) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return sandbox.spawn(command, args);
    };
    const { tools } = createSandboxTools(slow);
    const controller = new AbortController();
    const pending = tool(tools, "run_command").execute!(
      { command: "node" },
      { toolUseId: "t", signal: controller.signal, deadline: undefined }
    );
    controller.abort();
    expect(await pending).toContain("cancelled or stopped while the program was starting");
    expect(sandbox.killed).toEqual(["node"]);
  });

  it("starts nothing for a run that was already cancelled", async () => {
    const sandbox = new FakeSandbox();
    const { tools } = createSandboxTools(sandbox);
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool(tools, "run_command").execute!(
        { command: "node" },
        { toolUseId: "t", signal: controller.signal, deadline: undefined }
      )
    ).rejects.toThrow(/cancelled before/);
    expect(sandbox.spawned).toEqual([]);
  });

  it("tells every onPreview subscriber of a server, until it unsubscribes", async () => {
    const sandbox = new FakeSandbox({
      node: { chunks: [], exitCode: undefined, listensOn: 3000 },
    });
    const { tools, onPreview } = createSandboxTools(sandbox);
    const heard: string[] = [];
    const off = onPreview((url) => void heard.push(url));
    await call(tools, "run_command", { command: "node", background: true });
    expect(heard).toEqual(["http://localhost:3000"]);
    off();
    await call(tools, "stop_servers", {});
    await call(tools, "run_command", { command: "node", background: true });
    expect(heard).toHaveLength(1);
  });
});
