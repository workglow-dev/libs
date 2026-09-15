/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyTaskConstructor } from "@workglow/mcp/server";
import {
  buildTaskToolIndex,
  createTaskMcpServer,
  DEFAULT_MCP_PATH,
  startMcpHttpServer,
} from "@workglow/mcp/server";
import type { Command } from "commander";
import { resolveTaskType } from "../taskTypes";
import { resolveServeToken, serveUntilSignal } from "./serve";
import { consoleRoot } from "./web";

/** Nothing standard sits here, and it is one along from the web console. */
export const DEFAULT_MCP_PORT = 8788;

/**
 * Loopback by default, and deliberately not a wildcard by accident.
 *
 * Every tool this server offers is a task that can spend model quota, read
 * files or reach the network, so binding it where the network can reach it must
 * be something an operator says out loud rather than the default they get by
 * typing `mcp serve`.
 */
export const DEFAULT_MCP_HOST = "127.0.0.1";

/**
 * The environment variable a pinned token can arrive in.
 *
 * Preferred over `--token`: a client config has to hold the same token across
 * restarts, and an argument that never changes is one every other process on
 * the machine can read out of `ps`.
 */
export const MCP_TOKEN_ENV = "WORKGLOW_MCP_TOKEN";

interface McpServeOptions {
  readonly port: number;
  readonly host: string;
  readonly path: string;
  /** Commander's `--no-auth` counterpart: true unless the flag was passed. */
  readonly auth: boolean;
  readonly token?: string;
  readonly task?: string[];
}

/**
 * The task classes to offer, or `undefined` for "whatever is registered".
 *
 * Naming tasks explicitly also lifts the default filtering: an operator who
 * asked for a flow-control task by name has answered the question that filter
 * exists to guess at.
 */
function resolveSelection(names: readonly string[] | undefined): AnyTaskConstructor[] | undefined {
  if (!names || names.length === 0) return undefined;
  const selected: AnyTaskConstructor[] = [];
  for (const name of names) {
    const ctor = resolveTaskType(name);
    if (!ctor) {
      console.error(`Unknown task type "${name}".`);
      process.exit(1);
    }
    selected.push(ctor);
  }
  return selected;
}

/**
 * Adds `serve` to the `mcp` group: this CLI's registered tasks, offered to MCP
 * clients as tools over Streamable HTTP.
 */
export function registerMcpServeCommand(mcp: Command): void {
  mcp
    .command("serve")
    .description("Serve this CLI's registered tasks to MCP clients over HTTP")
    .option(
      "-p, --port <n>",
      "Port to listen on",
      (value) => Number.parseInt(value, 10),
      DEFAULT_MCP_PORT
    )
    .option(
      "--host <host>",
      "Interface to bind. The default is loopback: the tools here run tasks, so exposing them is an explicit choice.",
      DEFAULT_MCP_HOST
    )
    .option("--path <path>", "Path the MCP endpoint answers on", DEFAULT_MCP_PATH)
    .option(
      "--no-auth",
      "Serve without a bearer token. Anything that can reach the port can then run tasks."
    )
    .option(
      "--token <token>",
      `Use this bearer token instead of a generated one (or set ${MCP_TOKEN_ENV})`
    )
    .option("--task <type...>", "Offer only these task types, by the names `task list` prints")
    .action(async (opts: McpServeOptions) => {
      // Resolved here, not at registration: the group this hangs off is only
      // attached to its parents once the whole tree is built.
      const root = consoleRoot(mcp);
      const tasks = resolveSelection(opts.task);
      const selection = tasks ? { tasks, include: (): boolean => true } : {};

      const token = resolveServeToken(opts, MCP_TOKEN_ENV);

      const handle = await startMcpHttpServer({
        port: opts.port,
        host: opts.host,
        path: opts.path,
        token,
        createServer: () =>
          createTaskMcpServer({
            ...selection,
            name: root.name() || "workglow",
            version: root.version() ?? "0.0.0",
            instructions:
              "Each tool is one task type. A tool's input schema is that task's input ports, " +
              "and its result is the task's output.",
          }),
      });

      const served = buildTaskToolIndex(selection).size;
      console.log(`mcp server listening on ${handle.url} — ${served} tasks offered as tools`);
      if (token) {
        console.log(`bearer token: ${token}`);
        console.log(
          `client config: ${JSON.stringify({
            type: "http",
            url: handle.url,
            headers: { Authorization: `Bearer ${token}` },
          })}`
        );
      } else {
        console.error(
          "serving without authentication (--no-auth) — anything that can reach this port " +
            "can run tasks through it."
        );
      }
      if (opts.host !== DEFAULT_MCP_HOST && opts.host !== "localhost") {
        console.error(
          `bound to ${opts.host} — these tools run tasks that spend model quota and reach the ` +
            `network. Do not expose them to an untrusted network.`
        );
      }
      console.log("Press Ctrl-C to stop.");
      await serveUntilSignal(handle.close);
    });
}
