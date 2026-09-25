/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITask, ITaskConstructor } from "@workglow/task-graph";
import { TaskRegistry } from "@workglow/task-graph";
import type { DataPortSchemaObject } from "@workglow/util/schema";
import type { Command } from "commander";
import {
  generateConfigHelpText,
  generateSchemaHelpText,
  parseConfigFlags,
  parseDynamicFlags,
  resolveConfig,
  resolveInput,
  validateInput,
} from "../input";
import { promptMissingInput } from "../input/prompt";
import { deepMerge } from "../input/resolve-input";
import { withCli } from "../run-interactive";
import { isSignalCancellation, runFailureExitCode } from "../run-signal-abort";
import { resolveTaskType } from "../taskTypes";
import { renderSelectPrompt } from "../ui/render";
import { formatError, formatTable, outputResult } from "../util";

export function registerTaskCommand(program: Command): void {
  const task = program.command("task").description("List and run tasks");

  task
    .command("list")
    .description("List all registered task types")
    .action(async () => {
      const rows: Record<string, string>[] = [];
      for (const [, ctor] of TaskRegistry.all) {
        const category = ctor.category ?? "";
        // Filter out Flow Control tasks (ConditionalTask, MapTask, etc.)
        if (category === "Flow Control") continue;

        const typeName = ctor.type.endsWith("Task") ? ctor.type.slice(0, -4) : ctor.type;
        rows.push({
          type: typeName,
          category,
          description: ctor.description ?? "",
        });
      }

      if (rows.length === 0) {
        console.log("No tasks registered.");
        return;
      }

      rows.sort((a, b) => (a.category + a.type).localeCompare(b.category + b.type));
      console.log(formatTable(rows, ["type", "description"]));
    });

  task
    .command("detail")
    .argument("[type]", "task type to show")
    .description("Show details of a task type")
    .action(async (type: string | undefined) => {
      let targetType = type;
      if (!targetType) {
        if (!process.stdin.isTTY) {
          console.error("Error: specify a type or run interactively.");
          process.exit(1);
        }
        const options: Array<{ label: string; value: string }> = [];
        for (const [, ctor] of TaskRegistry.all) {
          const c = ctor as ITaskConstructor<any, any, any>;
          if (c.category === "Flow Control") continue;
          const typeName = c.type.endsWith("Task") ? c.type.slice(0, -4) : c.type;
          options.push({
            label: `${typeName}  ${c.category ?? ""}`,
            value: c.type,
          });
        }
        if (options.length === 0) {
          console.log("No tasks registered.");
          return;
        }
        options.sort((a, b) => a.label.localeCompare(b.label));
        const selected = await renderSelectPrompt(options, "Select task type:");
        if (!selected) return;
        targetType = selected;
      }

      const Ctor = resolveTaskType(targetType);
      if (!Ctor) {
        console.error(`Unknown task type "${targetType}".`);
        process.exit(1);
      }

      const detail: Record<string, unknown> = {
        type: Ctor.type,
        category: Ctor.category ?? null,
        title: Ctor.title ?? null,
        description: Ctor.description ?? null,
        inputSchema: Ctor.inputSchema(),
      };
      if (Ctor.configSchema) {
        detail.configSchema = Ctor.configSchema();
      }

      console.log(JSON.stringify(detail, null, 2));
    });

  const run = task
    .command("run", { isDefault: true })
    .argument("<type>", "task type to run")
    .description("Run a task by type")
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
    .action(async (type: string, opts: Record<string, string | boolean | undefined>) => {
      const Ctor = resolveTaskType(type);
      if (!Ctor) {
        console.error(`Unknown task type "${type}".`);
        process.exit(1);
      }

      const schemaRaw = Ctor.inputSchema();
      const schema: DataPortSchemaObject =
        typeof schemaRaw === "boolean" || !schemaRaw
          ? { type: "object" as const, properties: {} }
          : (schemaRaw as DataPortSchemaObject);

      const configSchemaRaw = Ctor.configSchema?.();
      const configSchema: DataPortSchemaObject =
        typeof configSchemaRaw === "object" && configSchemaRaw !== null
          ? (configSchemaRaw as DataPortSchemaObject)
          : { type: "object" as const, properties: {} };

      if (opts.help) {
        run.outputHelp();
        console.log("\nInput flags (from task schema):");
        console.log(generateSchemaHelpText(schema));
        const configHelp = generateConfigHelpText(configSchema, schema);
        if (configHelp !== "  (no config properties)") {
          console.log("\nConfig flags:");
          console.log(configHelp);
        }
        process.exit(0);
      }

      const dynamicFlags = parseDynamicFlags(process.argv, schema);
      let input = await resolveInput({
        inputJson: opts.inputJson as string | undefined,
        inputJsonFile: opts.inputJsonFile as string | undefined,
        dynamicFlags,
        schema,
      });
      const configFlags = parseConfigFlags(process.argv, configSchema, schema);
      const configFromJson = await resolveConfig({
        configJson: opts.configJson as string | undefined,
        configJsonFile: opts.configJsonFile as string | undefined,
      });
      const taskConfig = deepMerge(configFromJson, configFlags);

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

      try {
        const instance = new Ctor(taskConfig) as ITask;
        const result = await withCli(instance, { suppressResultOutput: true }).run(input);
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
