/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_A2A_PATH } from "@workglow/a2a/server";
import type { TaskGraphJson } from "@workglow/task-graph";
import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { describe, expect, it } from "vitest";
import { registerA2ACommand } from "./a2a";
import { A2A_TOKEN_ENV, DEFAULT_A2A_HOST, DEFAULT_A2A_PORT, descriptorFromGraph } from "./a2aServe";
import { resolveServeToken } from "./mcpServe";

const agentGraph = {
  tasks: [{ id: "a", type: "AgentTask", defaults: { model: "m", systemPrompt: "sys" } }],
  dataflows: [],
} as unknown as TaskGraphJson;

const notAnAgent = {
  tasks: [{ id: "a", type: "DelayTask", defaults: { delay: 1 } }],
  dataflows: [],
} as unknown as TaskGraphJson;

const twoNodes = {
  tasks: [
    { id: "a", type: "AgentTask", defaults: { model: "m" } },
    { id: "b", type: "DelayTask", defaults: { delay: 1 } },
  ],
  dataflows: [],
} as unknown as TaskGraphJson;

describe("descriptorFromGraph", () => {
  it("publishes a saved graph rooted at an AgentTask", () => {
    const found = descriptorFromGraph("researcher", agentGraph);
    expect(found?.id).toBe("researcher");
    expect(found?.skills).toHaveLength(1);
  });

  it("carries the saved defaults as the agent's input", () => {
    const found = descriptorFromGraph("researcher", agentGraph);
    expect(found?.agentInput.systemPrompt).toBe("sys");
    // A graph saved with no tool list holds none, and the turn loop wants a list.
    expect(found?.agentInput.tools).toEqual([]);
  });

  it("skips a saved graph that is not an agent", () => {
    // The agents folder holds task graphs, and only the ones that can hold a
    // conversation are servable. Publishing the rest offers a peer something
    // that cannot answer a message.
    expect(descriptorFromGraph("delayer", notAnAgent)).toBeUndefined();
  });

  it("skips a multi-node graph", () => {
    // One AgentTask is what this maps onto. A larger graph has no single
    // conversation to continue, and guessing which node is the agent is how a
    // peer ends up talking to a delay.
    expect(descriptorFromGraph("mixed", twoNodes)).toBeUndefined();
  });

  it("does not put the system prompt in the published description", () => {
    const found = descriptorFromGraph("researcher", agentGraph);
    expect(JSON.stringify({ d: found?.description, s: found?.skills })).not.toContain("sys");
  });
});

function serveCommand(): Command {
  const program = new CommanderCommand("workglow");
  registerA2ACommand(program);
  const a2a = program.commands.find((command) => command.name() === "a2a");
  const serve = a2a?.commands.find((command) => command.name() === "serve");
  if (!serve) throw new Error("a2a serve is not registered");
  return serve;
}

describe("a2a serve", () => {
  it("is reachable under the a2a group", () => {
    // A leaf that falls out of the group is otherwise invisible: the group
    // still builds, and `a2a --help` simply stops mentioning it.
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
      ])
    );
  });

  it("defaults to loopback, its own port, and the package's path", () => {
    const serve = serveCommand();
    expect(serve.getOptionValue("host")).toBe(DEFAULT_A2A_HOST);
    expect(serve.getOptionValue("port")).toBe(DEFAULT_A2A_PORT);
    expect(serve.getOptionValue("path")).toBe(DEFAULT_A2A_PATH);
  });

  it("reads a pinned token from its own variable, never the MCP server's", () => {
    // Two servers, two tokens: a token issued for one endpoint reaching the
    // other is a credential the operator never meant to share.
    const env = { WORKGLOW_MCP_TOKEN: "mcp", [A2A_TOKEN_ENV]: "a2a" };
    expect(resolveServeToken({ auth: true }, env, A2A_TOKEN_ENV)).toBe("a2a");
    expect(resolveServeToken({ auth: false }, env, A2A_TOKEN_ENV)).toBeNull();
  });
});
