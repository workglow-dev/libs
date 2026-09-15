/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { setGlobalModelRepository } from "@workglow/ai";
import { registerHuggingFaceTransformers } from "@workglow/huggingface-transformers/ai";
import {
  ChainedCredentialStore,
  EnvCredentialStore,
  globalServiceRegistry,
  HUMAN_CONNECTOR,
  setGlobalCredentialStore,
  Worker,
} from "@workglow/util";
import type { Command } from "commander";
import { program as defaultProgram } from "commander";
import path from "node:path";
import { registerA2ACommand } from "./commands/a2a";
import { registerAgentCommand } from "./commands/agent";
import { registerCredentialCommand } from "./commands/credential";
import { registerInitCommand } from "./commands/init";
import { registerMcpCommand } from "./commands/mcp";
import { registerModelCommand } from "./commands/model";
import { registerTaskCommand } from "./commands/task";
import type { RegisterWebCommandOptions } from "./commands/web";
import { registerWebCommand } from "./commands/web";
import { registerWorkflowCommand } from "./commands/workflow";
import { loadConfig } from "./config";
import { lazyStore } from "./keyring";
import { registerCliTasks } from "./registerCliTasks";
import { ensureRunReporting } from "./run-events/runReporting";
import { seedSamplesIfRepoEmpty } from "./samples/chatSample";
import { createModelRepository, createWorkflowRepository } from "./storage";
import { detectCliTheme, setCliTheme } from "./terminal/detectTerminalTheme";
import { InkHumanConnector } from "./ui/InkHumanConnector";

export interface WorkglowCliOptions {
  /** Program name, version and description shown in `--help`. */
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  /**
   * Register additional task types before the commands are wired.
   *
   * `task list` and `task run` enumerate the global {@link TaskRegistry}, so a
   * downstream CLI contributes its own tasks by registering them here — the
   * commands need no per-package knowledge, and the web console picks them up
   * from the same program.
   */
  readonly registerTasks?: () => void | Promise<void>;
  /** Add commands of your own, after the built-in ones are registered. */
  readonly registerCommands?: (program: Command) => void | Promise<void>;
  readonly web?: RegisterWebCommandOptions;
  /** Commander program to build on. Defaults to commander's shared one. */
  readonly program?: Command;
  readonly argv?: readonly string[];
  /**
   * Exit the process once the command settles (default true).
   *
   * The HFT worker and the model repository keep handles open, so a CLI that
   * merely returns from `parseAsync` hangs at the prompt instead of ending.
   */
  readonly exitOnComplete?: boolean;
}

/**
 * Boots the Workglow CLI runtime and runs one command.
 *
 * This is the whole of what the `workglow` binary does, exported so a
 * downstream CLI is a few lines rather than a copy: same task registrations,
 * same credential store, same model repository, same command set — including
 * `web` — with hooks to add its own tasks and commands.
 *
 * Keeping the body here rather than in a copied entry file is what keeps the
 * HuggingFace worker resolvable: its URL is relative to this module, so it
 * resolves inside the installed `@workglow/cli` no matter who called.
 */
export async function runWorkglowCli(options: WorkglowCliOptions = {}): Promise<void> {
  const program = options.program ?? defaultProgram;

  registerCliTasks();
  await options.registerTasks?.();

  // Lazy encrypted store (unlocked on demand) + env var fallback.
  setGlobalCredentialStore(new ChainedCredentialStore([lazyStore, new EnvCredentialStore()]));

  // A parent process asking for a machine-readable run gets one, and the human
  // connector goes with it: a run reporting over a pipe cannot prompt through Ink.
  if (!ensureRunReporting()) {
    globalServiceRegistry.registerInstance(HUMAN_CONNECTOR, new InkHumanConnector());
  }

  const config = await loadConfig();
  setCliTheme(await detectCliTheme());
  const modelRepo = createModelRepository(config);
  await modelRepo.setupDatabase();
  setGlobalModelRepository(modelRepo);

  const workflowRepo = createWorkflowRepository(config);
  await workflowRepo.setupDatabase();
  await seedSamplesIfRepoEmpty(workflowRepo);

  // Expose model cache path to the HFT worker via env var
  process.env.WORKGLOW_MODEL_CACHE = path.join(config.directories.cache, "onnx");

  await registerHuggingFaceTransformers({
    // `Worker` comes from @workglow/util rather than the global: Node exposes no
    // global `Worker`, so the global spelling only ran under Bun.
    // ".js" resolves in both modes: bun maps it to worker_hft.ts when running
    // from source, and the built dist contains worker_hft.js (a ".ts" specifier
    // would fail in dist — bun build does not rewrite worker URLs).
    worker: () => new Worker(new URL("./worker_hft.js", import.meta.url), { type: "module" }),
  });

  if (options.name) program.name(options.name);
  program
    .version(options.version ?? "2.0.0")
    .description(
      options.description ?? "Workglow CLI — manage models, workflows, agents, and tasks"
    );

  registerInitCommand(program);
  registerModelCommand(program);
  registerMcpCommand(program);
  registerWorkflowCommand(program);
  registerAgentCommand(program);
  registerA2ACommand(program);
  registerCredentialCommand(program);
  registerTaskCommand(program);
  registerWebCommand(program, options.web ?? {});
  await options.registerCommands?.(program);

  await program.parseAsync(options.argv ? [...options.argv] : process.argv);
  if (options.exitOnComplete !== false) process.exit(0);
}
