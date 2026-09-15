/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelRecord } from "@workglow/ai";
import { getGlobalModelRepository } from "@workglow/ai";
import type { Command } from "commander";
import { serveUntilSignal } from "./serve";
import { join } from "node:path";
import { loadConfig } from "../config";
import { ensureRunReporting } from "../run-events/runReporting";
import { createWorkflowRepository } from "../storage";
import { registerBuiltInSchemaProviders } from "../web/commandFields";
import { registerWebFieldWidget } from "../web/extensions";
import { startWebServer } from "../web/server";

/** Nothing standard sits here, and it is easy to type. */
export const DEFAULT_WEB_PORT = 8787;

/**
 * Loopback by default, and deliberately not a wildcard by accident.
 *
 * The console has no authentication beyond a per-process session token, and
 * every page can start work that spends real money on model calls, so binding
 * it to an interface the network can reach must be something an operator says
 * out loud rather than the default they get by typing `workglow web`.
 */
export const DEFAULT_WEB_HOST = "127.0.0.1";

export interface RegisterWebCommandOptions {
  /** Name shown in the rendered command line, e.g. `sec`. */
  readonly binaryName?: string;
  /** How to start this CLI as a child, defaulting to how it was started. */
  readonly binary?: readonly string[];
  readonly logDir?: string;
}

function defaultBinary(): readonly string[] {
  // argv[0] is the runtime and argv[1] is this program's entry, which is the
  // pair that reproduces the process a run has to be.
  return [process.argv[0], process.argv[1]];
}

/**
 * The widget behind `format: "model"`, which is the schema annotation every AI
 * task already carries — so a model field gets a picker with no per-command
 * wiring, the same way a downstream package's own format would.
 */
function registerBuiltInFieldWidgets(): void {
  registerWebFieldWidget({
    format: "model",
    source: "@workglow/cli",
    search: async (query) => {
      const models = (await getGlobalModelRepository().enumerateAllModels()) ?? [];
      const needle = query.trim().toLowerCase();
      return models
        .filter((model: ModelRecord) => !needle || model.model_id.toLowerCase().includes(needle))
        .slice(0, 50)
        .map((model: ModelRecord) => ({
          value: model.model_id,
          label: model.model_id,
          detail: model.provider,
        }));
    },
  });
}

/**
 * Adds `web` to a commander program. A downstream CLI gets the console — its
 * own commands included — by calling this once.
 */
/**
 * The command whose tree the console serves: the root of whatever `web` was
 * registered on. A CLI that files `web` under a group (`setup web`) still
 * means "this CLI's commands", not the group's — and the root is also where
 * the binary name lives, which the console prints in front of every run.
 */
export function consoleRoot(command: Command): Command {
  let root = command;
  while (root.parent !== null) root = root.parent;
  return root;
}

export function registerWebCommand(
  program: Command,
  options: RegisterWebCommandOptions = {}
): void {
  // Registration happens during this CLI's boot, which is also the boot of every
  // child the console spawns — so this is where a downstream binary picks up
  // reporting without having to know the channel exists.
  ensureRunReporting();

  program
    .command("web")
    .description("Serve a local web console for browsing, running and watching this CLI's commands")
    .option(
      "-p, --port <n>",
      "Port to listen on",
      (value) => Number.parseInt(value, 10),
      DEFAULT_WEB_PORT
    )
    .option(
      "--host <host>",
      "Interface to bind. The default is loopback: this console can start runs that spend model quota, so exposing it is an explicit choice.",
      DEFAULT_WEB_HOST
    )
    .action(async (opts: { port: number; host: string }) => {
      // Resolved here, not at registration: the group `web` hangs off is only
      // attached to its parents once the whole tree is built.
      const root = consoleRoot(program);
      const config = await loadConfig();
      const workflowRepo = createWorkflowRepository(config);
      await workflowRepo.setupDatabase();
      registerBuiltInSchemaProviders((id) => workflowRepo.getTaskGraph(id));
      registerBuiltInFieldWidgets();

      const handle = await startWebServer({
        port: opts.port,
        host: opts.host,
        program: root,
        binaryName: options.binaryName ?? root.name() ?? "workglow",
        binary: options.binary ?? defaultBinary(),
        cwd: process.cwd(),
        logDir: options.logDir ?? join(config.directories.cache, "web-runs"),
      });

      console.log(`web console listening on ${handle.url}/?t=${handle.token}`);
      if (opts.host !== DEFAULT_WEB_HOST && opts.host !== "localhost") {
        console.error(
          `bound to ${opts.host} — this console has no authentication beyond its session token ` +
            `and its buttons spend model quota. Do not expose it to an untrusted network.`
        );
      }
      console.log("Press Ctrl-C to stop.");

      // The server needs the database and job queue for as long as it is
      // serving, so the action returns only once a signal has closed it.
      await serveUntilSignal(handle.close);
    });
}
