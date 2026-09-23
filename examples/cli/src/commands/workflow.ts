/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TaskGraph, TaskGraphJson } from "@workglow/task-graph";
import {
  computeGraphInputSchema,
  createGraphFromGraphJSON,
  scanGraphForCredentials,
} from "@workglow/task-graph";
import type { DataPortSchemaObject } from "@workglow/util/schema";
import type { Command } from "commander";
import { registerCliBrowserDeps } from "../browser";
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
import { promptEditableInput, promptMissingInput } from "../input/prompt";
import { deepMerge } from "../input/resolve-input";
import { ensureCredentialStoreUnlocked } from "../keyring";
import { withCli } from "../run-interactive";
import { isSignalCancellation, runFailureExitCode } from "../run-signal-abort";
import { createWorkflowRepository } from "../storage";
import { renderSelectPrompt } from "../ui/render";
import { formatError, formatTable, outputResult } from "../util";

/**
 * Collects `task.defaults` from all root (no-incoming-edge) tasks in the graph
 * and returns a single merged object. Later overrides from CLI flags and JSON
 * input still win because this is merged *before* resolveInput's output.
 */
function collectRootTaskDefaults(graph: TaskGraph): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const tasks = graph.getTasks();
  for (const task of tasks) {
    if (graph.getSourceDataflows(task.id).length > 0) continue;
    const d = task.defaults;
    if (!d) continue;
    for (const [key, value] of Object.entries(d)) {
      if (value === undefined) continue;
      merged[key] = value;
    }
  }
  return merged;
}

export function registerWorkflowCommand(program: Command): void {
  const workflow = program.command("workflow").description("Manage and run workflows");

  workflow
    .command("list")
    .description("List all saved workflows")
    .action(async () => {
      const config = await loadConfig();
      const repo = createWorkflowRepository(config);
      await repo.setupDatabase();

      const all = await repo.tabularRepository.getAll();
      if (!all || all.length === 0) {
        console.log("No workflows found.");
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

  workflow
    .command("detail")
    .argument("[id]", "workflow identifier to show")
    .description("Show full details of a workflow")
    .action(async (id: string | undefined) => {
      const config = await loadConfig();
      const repo = createWorkflowRepository(config);
      await repo.setupDatabase();

      let targetId = id;
      if (!targetId) {
        if (!process.stdin.isTTY) {
          console.error("Error: specify an id or run interactively.");
          process.exit(1);
        }
        const all = await repo.tabularRepository.getAll();
        if (!all || all.length === 0) {
          console.log("No workflows found.");
          return;
        }
        const options = all.map((e) => ({
          label: String(e.key),
          value: String(e.key),
        }));
        const selected = await renderSelectPrompt(options, "Select workflow:");
        if (!selected) return;
        targetId = selected;
      }

      const entry = await repo.tabularRepository.get({ key: targetId });
      if (!entry) {
        console.error(`Workflow "${targetId}" not found.`);
        process.exit(1);
      }

      try {
        const parsed = JSON.parse(entry.value as string);
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log(entry.value);
      }
    });

  workflow
    .command("remove")
    .argument("[id]", "workflow identifier to remove")
    .description("Remove a workflow by ID")
    .action(async (id: string | undefined) => {
      const config = await loadConfig();
      const repo = createWorkflowRepository(config);
      await repo.setupDatabase();

      let targetId = id;
      if (!targetId) {
        if (!process.stdin.isTTY) {
          console.error("Error: specify an id or run interactively.");
          process.exit(1);
        }
        const all = await repo.tabularRepository.getAll();
        if (!all || all.length === 0) {
          console.log("No workflows to remove.");
          return;
        }
        const options = all.map((e) => ({
          label: String(e.key),
          value: String(e.key),
        }));
        const selected = await renderSelectPrompt(options, "Select workflow to remove:");
        if (!selected) return;
        targetId = selected;
      }

      await repo.tabularRepository.delete({ key: targetId });
      console.log(`Workflow "${targetId}" removed.`);
    });

  workflow
    .command("add")
    .argument("<id>", "workflow identifier")
    .description("Add a workflow from JSON")
    .option("--input-json <json>", "Workflow JSON as string")
    .option("--input-json-file <path>", "Workflow JSON from file")
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
      const repo = createWorkflowRepository(config);
      await repo.setupDatabase();

      await repo.saveTaskGraph(id, graph);
      console.log(`Workflow "${id}" added.`);
    });

  workflow
    .command("edit")
    .argument("[id]", "workflow identifier to edit")
    .description(
      "Edit workflow JSON in $GIT_EDITOR, $VISUAL, or $EDITOR; save the file to apply, or quit without saving to cancel"
    )
    .action(async (id: string | undefined) => {
      const config = await loadConfig();
      const repo = createWorkflowRepository(config);
      await repo.setupDatabase();

      let targetId = id;
      if (!targetId) {
        if (!process.stdin.isTTY) {
          console.error("Error: specify an id or run interactively.");
          process.exit(1);
        }
        const all = await repo.tabularRepository.getAll();
        if (!all || all.length === 0) {
          console.log("No workflows found.");
          return;
        }
        const options = all.map((e) => ({
          label: String(e.key),
          value: String(e.key),
        }));
        const selected = await renderSelectPrompt(options, "Select workflow to edit:");
        if (!selected) return;
        targetId = selected;
      }

      const entry = await repo.tabularRepository.get({ key: targetId });
      if (!entry) {
        console.error(`Workflow "${targetId}" not found.`);
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

      let graph;
      try {
        graph = createGraphFromGraphJSON(json);
      } catch (e) {
        console.error(`Invalid workflow: ${formatError(e)}`);
        process.exit(1);
      }

      await repo.saveTaskGraph(targetId, graph);
      console.log(`Workflow "${targetId}" saved.`);
    });

  const run = workflow
    .command("run")
    .argument("[id]", "workflow identifier to run")
    .description("Run a saved workflow")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .helpOption(false)
    .option("--input-json <json>", "Input as JSON string")
    .option("--input-json-file <path>", "Input from JSON file")
    .option("--config-json <json>", "Config as JSON string")
    .option("--config-json-file <path>", "Config from JSON file")
    .option("--output-json-file <path>", "Write output to file")
    .option(
      "-i, --interactive",
      "Always show the full input form, even when defaults cover all required fields"
    )
    .option("--dry-run", "Validate input without executing")
    .option("--help", "Show help including schema-derived flags")
    .action(async (id: string | undefined, opts: Record<string, string | boolean | undefined>) => {
      const config = await loadConfig();
      const repo = createWorkflowRepository(config);
      await repo.setupDatabase();

      let targetId = id;
      if (!targetId) {
        if (opts.help) {
          run.outputHelp();
          console.log("\nInput flags: pass a workflow id to see schema-derived flags.");
          process.exit(0);
        }
        if (!process.stdin.isTTY) {
          console.error("Error: specify an id or run interactively.");
          process.exit(1);
        }
        const all = await repo.tabularRepository.getAll();
        if (!all || all.length === 0) {
          console.log("No workflows found.");
          return;
        }
        const options = all.map((e) => ({
          label: String(e.key),
          value: String(e.key),
        }));
        const selected = await renderSelectPrompt(options, "Select workflow to run:");
        if (!selected) return;
        targetId = selected;
      }

      const graph = await repo.getTaskGraph(targetId);
      if (!graph) {
        console.error(`Workflow "${targetId}" not found.`);
        process.exit(1);
      }

      const schemaRaw = computeGraphInputSchema(graph);
      const schema: DataPortSchemaObject =
        typeof schemaRaw === "boolean"
          ? { type: "object" as const, properties: {} }
          : (schemaRaw as DataPortSchemaObject);

      if (opts.help) {
        run.outputHelp();
        console.log("\nInput flags (from workflow schema):");
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

      // Merge root-task defaults (e.g. sample workflows that pre-fill model config)
      // so the interactive prompt treats those fields as already satisfied.
      input = deepMerge(collectRootTaskDefaults(graph), input);

      if (process.stdin.isTTY) {
        if (opts.interactive) {
          input = await promptEditableInput(input, schema);
        } else {
          input = await promptMissingInput(input, schema);
        }
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

      await registerCliBrowserDeps(config);

      try {
        const result = await withCli(graph, { suppressResultOutput: true }).run(input, runConfig);
        if (!process.stdout.isTTY || opts.outputJsonFile) {
          await outputResult(result, opts.outputJsonFile as string | undefined);
        }
      } catch (err) {
        if (!isSignalCancellation(err)) {
          console.error(`Error: ${formatError(err)}`);
        }
        process.exit(runFailureExitCode(err));
      }
    });
}
