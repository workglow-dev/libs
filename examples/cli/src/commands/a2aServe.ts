/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_A2A_PATH, startA2AHttpServer } from "@workglow/a2a/server";
import type { IA2AAgentDescriptor } from "@workglow/a2a/util";
import type { AgentTaskInput } from "@workglow/ai";
import { AgentTask } from "@workglow/ai";
import type { TaskGraphJson } from "@workglow/task-graph";
import type { Command } from "commander";
import { loadConfig } from "../config";
import { ensureCredentialStoreUnlocked } from "../keyring";
import { createAgentRepository } from "../storage";
import { resolveServeToken } from "./mcpServe";

/** Nothing standard sits here, and it is one along from the MCP server. */
export const DEFAULT_A2A_PORT = 8789;

/**
 * Loopback by default, and deliberately not a wildcard by accident.
 *
 * Every message this server accepts runs an agent that can spend model quota
 * and call whatever tools its saved graph holds, so binding it where the
 * network can reach it must be something an operator says out loud.
 */
export const DEFAULT_A2A_HOST = "127.0.0.1";

/**
 * The environment variable a pinned token can arrive in.
 *
 * Preferred over `--token`: a peer's config has to hold the same token across
 * restarts, and an argument that never changes is one every other process on
 * the machine can read out of `ps`.
 */
export const A2A_TOKEN_ENV = "WORKGLOW_A2A_TOKEN";

interface A2AServeOptions {
  readonly port: number;
  readonly host: string;
  readonly path: string;
  /** Commander's `--no-auth` counterpart: true unless the flag was passed. */
  readonly auth: boolean;
  readonly token?: string;
}

/**
 * A saved graph, as one servable agent — or nothing.
 *
 * Only a single `AgentTask` maps: A2A publishes one agent per card, and an
 * agent is a conversation a peer continues. A larger graph has no single
 * conversation, and the rest of the agents folder holds graphs that cannot
 * answer a message at all.
 */
export function descriptorFromGraph(
  id: string,
  graph: TaskGraphJson
): IA2AAgentDescriptor | undefined {
  const tasks = graph.tasks ?? [];
  if (tasks.length !== 1) return undefined;
  const node = tasks[0];
  if (!node || node.type !== AgentTask.type) return undefined;

  // The prompt is the one field a peer supplies; everything else saved on the
  // node is the host's, and a graph saved without a tool list holds none.
  const { prompt: _prompt, ...saved } = (node.defaults ?? {}) as Partial<AgentTaskInput>;
  const agentInput: IA2AAgentDescriptor["agentInput"] = {
    ...saved,
    model: saved.model ?? "",
    tools: saved.tools ?? [],
  };
  return {
    id,
    name: id,
    // Deliberately not the system prompt: the card is public, and the prompt
    // is the half an opaque peer must not read.
    description: `The "${id}" agent.`,
    version: "1.0.0",
    skills: [
      {
        id: "message",
        name: "Message",
        description: `Send a message to the "${id}" agent.`,
        tags: [],
        examples: [],
        inputSchema: undefined,
      },
    ],
    agentInput,
  };
}

/** Adds `serve` to the `a2a` group: one saved agent, published to A2A peers. */
export function registerA2AServeCommand(a2a: Command): void {
  a2a
    .command("serve")
    .argument("<id>", "Saved agent to publish, by the name `agent list` prints")
    .description("Publish one saved agent to A2A peers over HTTP")
    .option(
      "-p, --port <n>",
      "Port to listen on",
      (value) => Number.parseInt(value, 10),
      DEFAULT_A2A_PORT
    )
    .option(
      "--host <host>",
      "Interface to bind. The default is loopback: a message here runs an agent, so exposing it is an explicit choice.",
      DEFAULT_A2A_HOST
    )
    .option("--path <path>", "Path the JSON-RPC endpoint answers on", DEFAULT_A2A_PATH)
    .option(
      "--no-auth",
      "Serve without a bearer token. Anything that can reach the port can then run the agent."
    )
    .option(
      "--token <token>",
      `Use this bearer token instead of a generated one (or set ${A2A_TOKEN_ENV})`
    )
    .action(async (id: string, opts: A2AServeOptions) => {
      const config = await loadConfig();
      const repo = createAgentRepository(config);
      await repo.setupDatabase();

      const graph = await repo.getTaskGraph(id);
      if (!graph) {
        console.error(`Agent "${id}" not found.`);
        process.exit(1);
      }
      const descriptor = descriptorFromGraph(id, graph.toJSON());
      if (!descriptor) {
        console.error(`Agent "${id}" is not a single AgentTask, so it cannot be served.`);
        process.exit(1);
      }

      // The agent's model needs its key before the first peer arrives, not
      // after — a prompt for a passphrase in the middle of serving a request
      // is one nobody is there to answer.
      await ensureCredentialStoreUnlocked();

      const token = resolveServeToken(opts, process.env, A2A_TOKEN_ENV);
      const handle = await startA2AHttpServer({
        port: opts.port,
        host: opts.host,
        path: opts.path,
        token,
        descriptor,
      });

      console.log(`a2a server listening on ${handle.url} — serving agent "${id}"`);
      console.log(`agent card: ${handle.cardUrl}`);
      if (token) {
        console.log(`bearer token: ${token}`);
      } else {
        console.error(
          "serving without authentication (--no-auth) — anything that can reach this port " +
            "can run this agent."
        );
      }
      if (opts.host !== DEFAULT_A2A_HOST && opts.host !== "localhost") {
        console.error(
          `bound to ${opts.host} — this agent spends model quota and reaches whatever its ` +
            `tools reach. Do not expose it to an untrusted network.`
        );
      }
      console.log("Press Ctrl-C to stop.");

      // The action deliberately never resolves: the CLI tears down once an
      // action returns, and the server needs the runtime for as long as it is
      // serving. Ctrl-C unblocks it, and teardown then runs once.
      await new Promise<void>((resolve) => {
        const shutdown = (): void => {
          console.log("shutting down");
          void handle.close().then(() => resolve());
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
    });
}
