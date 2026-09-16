/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_A2A_PATH, startA2AHttpServer } from "@workglow/a2a/server";
import type { IA2AAgentDescriptor } from "@workglow/a2a/util";
import type { AgentTaskInput } from "@workglow/ai";
import { AGENT_APPROVAL_OPT_OUT, AgentTask } from "@workglow/ai";
import type { TaskGraphJson } from "@workglow/task-graph";
import { globalServiceRegistry, HUMAN_CONNECTOR } from "@workglow/util";
import type { Command } from "commander";
import { loadConfig } from "../config";
import { ensureCredentialStoreUnlocked } from "../keyring";
import { createAgentRepository } from "../storage";
import { HeadlessHumanConnector } from "../ui/HeadlessHumanConnector";
import { formatError } from "../util";
import { resolveServeToken, serveUntilSignal } from "./serve";

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
  /** Commander's `--no-approval` counterpart: true unless the flag was passed. */
  readonly approval: boolean;
}

/**
 * A saved graph, as one servable agent — or the reason it is not one.
 *
 * Only a single `AgentTask` maps: A2A publishes one agent per card, and an
 * agent is a conversation a peer continues. A larger graph has no single
 * conversation, and the rest of the agents folder holds graphs that cannot
 * answer a message at all. A node saved without a model is refused here too,
 * at startup, rather than discovered by the first peer to write.
 */
export function descriptorFromGraph(id: string, graph: TaskGraphJson): IA2AAgentDescriptor {
  const tasks = graph.tasks ?? [];
  if (tasks.length !== 1) {
    throw new Error(
      `Agent "${id}" holds ${tasks.length} tasks; only a single AgentTask can be served.`
    );
  }
  const node = tasks[0]!;
  if (node.type !== AgentTask.type) {
    throw new Error(
      `Agent "${id}" is a ${node.type}, not an AgentTask, so it cannot answer a message.`
    );
  }

  // The prompt is the one field a peer supplies; everything else saved on the
  // node is the host's, and a graph saved without a tool list holds none.
  const { prompt: _prompt, ...saved } = (node.defaults ?? {}) as Partial<AgentTaskInput>;
  if (!saved.model) {
    throw new Error(`Agent "${id}" names no model, so it cannot be served.`);
  }
  const agentInput: IA2AAgentDescriptor["agentInput"] = {
    ...saved,
    model: saved.model,
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
    .option(
      "--no-approval",
      "Run every tool without asking. The default declines anything reaching past the model, since no person is here to approve it."
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
      let described: IA2AAgentDescriptor;
      try {
        described = descriptorFromGraph(id, graph.toJSON());
      } catch (error) {
        console.error(formatError(error));
        process.exit(1);
      }
      // A served agent has no person to ask. `--no-approval` runs its tools
      // regardless; the default declines each request in words the model can
      // act on, instead of leaving the process's own terminal prompt to throw.
      //
      // The opt-out is registered as well as set on the input, because the
      // input half came out of a saved graph and the turn will not lower its
      // gate on a document's say-so.
      const descriptor: IA2AAgentDescriptor = opts.approval
        ? described
        : { ...described, agentInput: { ...described.agentInput, approval: "never" } };
      if (opts.approval) {
        globalServiceRegistry.registerInstance(
          HUMAN_CONNECTOR,
          new HeadlessHumanConnector(
            `The "${id}" agent is served to other programs and nobody is here to approve this. ` +
              "Start it with --no-approval to run tools unasked."
          )
        );
      } else {
        globalServiceRegistry.registerInstance(AGENT_APPROVAL_OPT_OUT, true);
      }

      // The agent's model needs its key before the first peer arrives, not
      // after — a prompt for a passphrase in the middle of serving a request
      // is one nobody is there to answer.
      await ensureCredentialStoreUnlocked();

      const token = resolveServeToken(opts, A2A_TOKEN_ENV);
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
      await serveUntilSignal(handle.close);
    });
}
