/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_MCP_PATH } from "@workglow/mcp/server";
import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { describe, expect, it } from "vitest";
import { registerMcpCommand } from "./mcp";
import { DEFAULT_MCP_HOST, DEFAULT_MCP_PORT, MCP_TOKEN_ENV } from "./mcpServe";
import { resolveServeToken } from "./serve";

function serveCommand(): Command {
  const program = new CommanderCommand("workglow");
  registerMcpCommand(program);
  const mcp = program.commands.find((command) => command.name() === "mcp");
  const serve = mcp?.commands.find((command) => command.name() === "serve");
  if (!serve) throw new Error("mcp serve is not registered");
  return serve;
}

describe("mcp serve", () => {
  it("is reachable under the mcp group", () => {
    // A leaf that falls out of the group is otherwise invisible: the group
    // still builds, and `mcp --help` simply stops mentioning it.
    expect(serveCommand().name()).toBe("serve");
  });

  it("declares the flags an operator needs to place and expose it", () => {
    const flags = serveCommand().options.map((option) => option.flags);
    expect(flags).toEqual(
      expect.arrayContaining([
        "-p, --port <n>",
        "--host <host>",
        "--path <path>",
        "--no-auth",
        "--token <token>",
        "--task <type...>",
      ])
    );
  });

  it("defaults to loopback, its own port and the shared endpoint path", () => {
    // Not a wildcard by accident: every tool here runs a task.
    expect(serveCommand().opts()).toMatchObject({
      host: DEFAULT_MCP_HOST,
      port: DEFAULT_MCP_PORT,
      path: DEFAULT_MCP_PATH,
    });
    expect(DEFAULT_MCP_HOST).toBe("127.0.0.1");
  });

  it("does not share the web console's port", () => {
    expect(DEFAULT_MCP_PORT).not.toBe(8787);
  });
});

describe("resolveServeToken", () => {
  it("generates a token when nothing pinned one", () => {
    const token = resolveServeToken({ auth: true }, MCP_TOKEN_ENV, {});
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(resolveServeToken({ auth: true }, MCP_TOKEN_ENV, {})).not.toBe(token);
  });

  it("prefers a pinned token, so a client config survives a restart", () => {
    expect(resolveServeToken({ auth: true, token: "pinned" }, MCP_TOKEN_ENV, {})).toBe("pinned");
    expect(resolveServeToken({ auth: true }, MCP_TOKEN_ENV, { [MCP_TOKEN_ENV]: "from-env" })).toBe(
      "from-env"
    );
    expect(
      resolveServeToken({ auth: true, token: "pinned" }, MCP_TOKEN_ENV, {
        [MCP_TOKEN_ENV]: "from-env",
      })
    ).toBe("pinned");
  });

  it("generates rather than serving unauthenticated on an empty token", () => {
    // An empty flag or variable is a mistake, not a request to drop the gate.
    expect(resolveServeToken({ auth: true, token: "" }, MCP_TOKEN_ENV, {})).toBeTruthy();
    expect(resolveServeToken({ auth: true }, MCP_TOKEN_ENV, { [MCP_TOKEN_ENV]: "" })).toBeTruthy();
  });

  it("serves without a token only when --no-auth said so", () => {
    expect(
      resolveServeToken({ auth: false }, MCP_TOKEN_ENV, { [MCP_TOKEN_ENV]: "from-env" })
    ).toBeNull();
  });
});
