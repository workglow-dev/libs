/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolDefinition } from "@workglow/ai";
import { AgentTask, taskTypesToTools } from "@workglow/ai";
import {
  computeGraphInputSchema,
  createGraphFromGraphJSON,
  scanGraphForCredentials,
  type TaskDeserializationOptions,
  type TaskGraphJson,
} from "@workglow/task-graph";
import type { DataPortSchemaObject } from "@workglow/util/schema";
import type { Command } from "commander";
import { loadConfig } from "../config";
import { editStringInExternalEditor } from "../editInEditor";
import {
  generateSchemaHelpText,
  parseDynamicFlags,
  readJsonInput,
  resolveConfig,
  resolveInput,
  validateInput,
} from "../input";
import { promptMissingInput } from "../input/prompt";
import { ensureCredentialStoreUnlocked } from "../keyring";
import { createAgentRepository } from "../storage";
import { renderSelectPrompt, renderWorkflowRun } from "../ui/render";
import { formatError, formatTable, outputResult } from "../util";
import { runAgentChat } from "../agent/runAgentChat";
import { ensureRunReporting } from "../run-events/runReporting";

export function registerAgentCommand(program: Command): void {
  const agent = program.command("agent").description("Manage and run agents");

  agent
    .command("list")
    .description("List all saved agents")
    .action(async () => {
      const config = await loadConfig();
      const repo = createAgentRepository(config);
      await repo.setupDatabase();

      const all = await repo.tabularRepository.getAll();
      if (!all || all.length === 0) {
        console.log("No agents found.");
        return;
      }

      const rows = all.map((entry) => {
        let taskCount = "";
        try {
          const parsed = JSON.parse(entry.value as string) as TaskGraphJson;
          taskCount = String(parsed.tasks?.length ?? 0);
        } catch {
          taskCount = "?";
        }
        return {
          key: entry.key as string,
          tasks: taskCount,
        };
      });

      console.log(formatTable(rows, ["key", "tasks"]));
    });

  agent
    .command("detail")
    .argument("[id]", "agent identifier to show")
    .description("Show full details of an agent")
    .action(async (id: string | undefined) => {
      const config = await loadConfig();
      const repo = createAgentRepository(config);
      await repo.setupDatabase();

      let targetId = id;
      if (!targetId) {
        if (!process.stdin.isTTY) {
          console.error("Error: specify an id or run interactively.");
          process.exit(1);
        }
        const all = await repo.tabularRepository.getAll();
        if (!all || all.length === 0) {
          console.log("No agents found.");
          return;
        }
        const options = all.map((e) => ({
          label: String(e.key),
          value: String(e.key),
        }));
        const selected = await renderSelectPrompt(options, "Select agent:");
        if (!selected) return;
        targetId = selected;
      }

      const entry = await repo.tabularRepository.get({ key: targetId });
      if (!entry) {
        console.error(`Agent "${targetId}" not found.`);
        process.exit(1);
      }

      try {
        const parsed = JSON.parse(entry.value as string);
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log(entry.value);
      }
    });

  agent
    .command("remove")
    .argument("[id]", "agent identifier to remove")
    .description("Remove an agent by ID")
    .action(async (id: string | undefined) => {
      const config = await loadConfig();
      const repo = createAgentRepository(config);
      await repo.setupDatabase();

      let targetId = id;
      if (!targetId) {
        if (!process.stdin.isTTY) {
          console.error("Error: specify an id or run interactively.");
          process.exit(1);
        }
        const all = await repo.tabularRepository.getAll();
        if (!all || all.length === 0) {
          console.log("No agents to remove.");
          return;
        }
        const options = all.map((e) => ({
          label: String(e.key),
          value: String(e.key),
        }));
        const selected = await renderSelectPrompt(options, "Select agent to remove:");
        if (!selected) return;
        targetId = selected;
      }

      await repo.tabularRepository.delete({ key: targetId });
      console.log(`Agent "${targetId}" removed.`);
    });

  agent
    .command("add")
    .argument("<id>", "agent identifier")
    .description("Add an agent from JSON")
    .option("--input-json <json>", "Agent JSON as string")
    .option("--input-json-file <path>", "Agent JSON from file")
    .option("--dry-run", "Validate without saving")
    .action(async (id: string, opts: Record<string, string | boolean | undefined>) => {
      const json = await readJsonInput({
        inputJson: opts.inputJson as string | undefined,
        inputJsonFile: opts.inputJsonFile as string | undefined,
      });

      const graph = createGraphFromGraphJSON(json as TaskGraphJson);

      if (opts.dryRun) {
        console.log(JSON.stringify(graph.toJSON(), null, 2));
        process.exit(0);
      }

      const config = await loadConfig();
      const repo = createAgentRepository(config);
      await repo.setupDatabase();

      await repo.saveTaskGraph(id, graph);
      console.log(`Agent "${id}" added.`);
    });

  agent
    .command("edit")
    .argument("[id]", "agent identifier to edit")
    .description(
      "Edit agent JSON in $GIT_EDITOR, $VISUAL, or $EDITOR; save to apply, or quit without saving to cancel"
    )
    .action(async (id: string | undefined) => {
      const config = await loadConfig();
      const repo = createAgentRepository(config);
      await repo.setupDatabase();

      let targetId = id;
      if (!targetId) {
        if (!process.stdin.isTTY) {
          console.error("Error: specify an id or run interactively.");
          process.exit(1);
        }
        const all = await repo.tabularRepository.getAll();
        if (!all || all.length === 0) {
          console.log("No agents found.");
          return;
        }
        const options = all.map((e) => ({
          label: String(e.key),
          value: String(e.key),
        }));
        const selected = await renderSelectPrompt(options, "Select agent to edit:");
        if (!selected) return;
        targetId = selected;
      }

      const entry = await repo.tabularRepository.get({ key: targetId });
      if (!entry) {
        console.error(`Agent "${targetId}" not found.`);
        process.exit(1);
      }

      const raw = entry.value as string;
      let initial: string;
      try {
        initial = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        initial = raw;
      }

      const result = editStringInExternalEditor(
        initial,
        `${targetId.replace(/[^\w.-]+/g, "_")}.json`
      );

      if (result.status === "unchanged") {
        console.log("Aborted: file unchanged (quit the editor without saving).");
        return;
      }

      if (result.status === "editor_error") {
        console.error(`Editor failed: ${result.message}`);
        process.exit(1);
      }

      let json: TaskGraphJson;
      try {
        json = JSON.parse(result.content) as TaskGraphJson;
      } catch (e) {
        console.error(`Invalid JSON: ${formatError(e)}`);
        process.exit(1);
      }

      // Restrict which task types can be instantiated from untrusted agent JSON.
      // This allowlist should include only task types that are safe and expected in agent graphs.
      const deserializationOptions: TaskDeserializationOptions = {
        allowedTypes: new Set<string>([
          // Core control-flow / composition tasks
          "GraphAsTask",
          "ConditionalTask",
          "IteratorTask",
          "MapTask",
          "ReduceTask",
          "WhileTask",
          // Add additional allowed task type names here as needed.
        ]),
      };

      let graph;
      try {
        graph = createGraphFromGraphJSON(json, undefined, deserializationOptions);
      } catch (e) {
        console.error(`Invalid agent graph: ${formatError(e)}`);
        process.exit(1);
      }

      await repo.saveTaskGraph(targetId, graph);
      console.log(`Agent "${targetId}" saved.`);
    });

  const run = agent
    .command("run")
    .argument("<id>", "agent identifier to run")
    .description("Run a saved agent")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .helpOption(false)
    .option("--input-json <json>", "Input as JSON string")
    .option("--input-json-file <path>", "Input from JSON file")
    .option("--config-json <json>", "Config as JSON string")
    .option("--config-json-file <path>", "Config from JSON file")
    .option("--output-json-file <path>", "Write output to file")
    .option("--dry-run", "Validate input without executing")
    .option("--help", "Show help including schema-derived flags")
    .action(async (id: string, opts: Record<string, string | boolean | undefined>) => {
      const config = await loadConfig();
      const repo = createAgentRepository(config);
      await repo.setupDatabase();

      const graph = await repo.getTaskGraph(id);
      if (!graph) {
        console.error(`Agent "${id}" not found.`);
        process.exit(1);
      }

      const schemaRaw = computeGraphInputSchema(graph);
      const schema: DataPortSchemaObject =
        typeof schemaRaw === "boolean"
          ? { type: "object" as const, properties: {} }
          : (schemaRaw as DataPortSchemaObject);

      if (opts.help) {
        run.outputHelp();
        console.log("\nInput flags (from agent schema):");
        console.log(generateSchemaHelpText(schema));
        process.exit(0);
      }

      const dynamicFlags = parseDynamicFlags(process.argv, schema);
      let input = await resolveInput({
        inputJson: opts.inputJson as string | undefined,
        inputJsonFile: opts.inputJsonFile as string | undefined,
        dynamicFlags,
        schema,
      });
      const runConfig = await resolveConfig({
        configJson: opts.configJson as string | undefined,
        configJsonFile: opts.configJsonFile as string | undefined,
      });

      if (process.stdin.isTTY) {
        input = await promptMissingInput(input, schema);
      }

      const validation = validateInput(input, schema);
      if (!validation.valid) {
        console.error("Input validation failed:");
        for (const err of validation.errors) {
          console.error(`  - ${err}`);
        }
        process.exit(1);
      }

      if (opts.dryRun) {
        console.log(JSON.stringify(input, null, 2));
        process.exit(0);
      }

      // Unlock encrypted credential store if the graph needs credentials
      const scanResult = scanGraphForCredentials(graph);
      if (scanResult.needsCredentials) {
        await ensureCredentialStoreUnlocked();
      }

      try {
        if (process.stdout.isTTY) {
          await renderWorkflowRun(graph, input, {
            outputJsonFile: opts.outputJsonFile as string | undefined,
            config: runConfig,
          });
        } else {
          const result = await graph.run(input, runConfig);
          await outputResult(result, opts.outputJsonFile as string | undefined);
        }
      } catch (err) {
        console.error(`Error: ${formatError(err)}`);
        process.exit(1);
      }
    });

  agent
    .command("chat")
    .description("Talk to a model that can run registered tasks as tools")
    .option("-m, --model <id>", "Model to use; prompted for when omitted")
    .option(
      "-t, --tools <types>",
      "Comma-separated task types the model may call. None by default — an agent reaches only what it is given."
    )
    .option("-s, --system <text>", "System prompt")
    .option("--max-rounds <n>", "Model calls per turn before it gives up", parseRounds)
    .option(
      "--no-approval",
      "Run every tool without asking. For a session you are not watching; the default confirms anything reaching past the model."
    )
    .action(async (opts: Record<string, unknown>) => {
      // A session started from the web console has no terminal and does not
      // need one: it asks and answers over the run's event channel. What it
      // cannot do is read a line from a pipe nobody is typing into.
      if (!process.stdin.isTTY && !ensureRunReporting()) {
        console.error(
          "agent chat needs a terminal, or the web console. Use `workglow task run AgentTask` for a scripted turn."
        );
        process.exit(1);
      }
      let tools: ToolDefinition[];
      try {
        tools = toolsFromTypes(opts.tools as string | undefined);
      } catch (err) {
        console.error(`Error: ${formatError(err)}`);
        process.exit(1);
      }
      const model = await resolveChatModel(opts.model as string | undefined);
      await ensureCredentialStoreUnlocked();
      await runAgentChat({
        model,
        tools,
        systemPrompt: opts.system as string | undefined,
        maxRounds: opts.maxRounds as number | undefined,
        // Commander gives `--no-approval` as `approval: false`.
        approval: opts.approval === false ? "never" : "beyond-inference",
      });
    });
}

function parseRounds(raw: string): number {
  const rounds = Number.parseInt(raw, 10);
  if (!Number.isFinite(rounds) || rounds < 1) {
    throw new Error(`--max-rounds must be a positive integer, got "${raw}"`);
  }
  return rounds;
}

/**
 * The task types named on `--tools`, as tool definitions.
 *
 * No default, for the reason a pinned search provider has none: which tools an
 * agent holds decides what it can reach, and inheriting a set nobody chose is
 * how a chat session ends up able to write files.
 */
function toolsFromTypes(raw: string | undefined): ToolDefinition[] {
  const names = (raw ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return names.length === 0 ? [] : taskTypesToTools(names);
}

/** `--model`, or the same picker every other model port gets. */
async function resolveChatModel(named: string | undefined): Promise<string> {
  if (named) return named;
  // Only the model port, so the picker asks the one thing a session needs and
  // does not walk the rest of the task's inputs.
  const full = AgentTask.inputSchema() as DataPortSchemaObject;
  const schema: DataPortSchemaObject = {
    type: "object",
    properties: { model: full.properties.model! },
    required: ["model"],
  };
  const filled = await promptMissingInput({}, schema);
  const model = filled.model;
  if (typeof model !== "string" || model.length === 0) {
    throw new Error("No model chosen");
  }
  return model;
}
