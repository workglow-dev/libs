/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { asText } from "@workglow/util";
import type { ModelRecord, ModelSearchResultItem } from "@workglow/ai";
import { ModelRecordSchema, modelSearch } from "@workglow/ai";
import { AnthropicModelRecordSchema } from "@workglow/anthropic/ai";
import { DeepSeekModelRecordSchema } from "@workglow/deepseek/ai";
import { GeminiModelRecordSchema } from "@workglow/google-gemini/ai";
import { HfInferenceModelRecordSchema } from "@workglow/huggingface-inference/ai";
import {
  HfTransformersOnnxModelRecordSchema,
  parseOnnxQuantizations,
} from "@workglow/huggingface-transformers/ai";
import { MetaModelRecordSchema } from "@workglow/meta/ai";
import { LlamaCppModelRecordSchema } from "@workglow/node-llama-cpp/ai";
import { OllamaModelRecordSchema } from "@workglow/ollama/ai";
import { OpenAiModelRecordSchema } from "@workglow/openai/ai";
import type { DataPortSchemaObject } from "@workglow/util/schema";
import { XaiModelRecordSchema } from "@workglow/xai/ai";
import type { Command } from "commander";
import { loadConfig } from "../config";
import { editStringInExternalEditor } from "../editInEditor";
import {
  applySchemaDefaults,
  generateSchemaHelpText,
  parseDynamicFlags,
  resolveInput,
  validateInput,
} from "../input";
import { promptEditableInput, promptMissingInput } from "../input/prompt";
import { createModelRepository } from "../storage";
import type { SearchSelectItem } from "../ui/render";
import { renderSearchSelect, renderSelectPrompt } from "../ui/render";
import { formatError, formatTable } from "../util";

const PROVIDER_SCHEMAS: Record<string, DataPortSchemaObject> = {
  ANTHROPIC: AnthropicModelRecordSchema,
  OPENAI: OpenAiModelRecordSchema,
  XAI: XaiModelRecordSchema,
  DEEPSEEK: DeepSeekModelRecordSchema,
  META: MetaModelRecordSchema,
  GOOGLE_GEMINI: GeminiModelRecordSchema,
  OLLAMA: OllamaModelRecordSchema,
  HF_INFERENCE: HfInferenceModelRecordSchema,
  HF_TRANSFORMERS_ONNX: HfTransformersOnnxModelRecordSchema,
  LOCAL_LLAMACPP: LlamaCppModelRecordSchema,
};

const AVAILABLE_PROVIDERS = Object.keys(PROVIDER_SCHEMAS);

function detectProviderFromArgv(argv: string[]): string | undefined {
  for (const arg of argv) {
    const match = arg.match(/^-provider[=\s](.+)/);
    if (match) return match[1];
    if (arg === "-provider") {
      const idx = argv.indexOf(arg);
      if (idx + 1 < argv.length) return argv[idx + 1];
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Provider search (delegates to ModelSearchTask via modelSearch())
// ---------------------------------------------------------------------------

interface ModelSearchSelectItem extends SearchSelectItem {
  readonly result: ModelSearchResultItem;
}

/**
 * Normalize HF_TRANSFORMERS_ONNX device for the CLI.
 *
 * The CLI schema prompt seeds schema defaults into the output, so `provider_config.device`
 * often ends up as `"webgpu"` even when the user didn't explicitly choose anything.
 *
 * For the CLI we want `device` to be `undefined` by default so transformers.js can auto-select
 * based on what the runtime supports.
 *
 * Also, on the Node build, transformers.js rejects `device: "wasm"`, so we drop it entirely.
 */
function normalizeHfTransformersOnnxDevice(record: Record<string, unknown>): void {
  if (record.provider !== "HF_TRANSFORMERS_ONNX") return;
  const pc = record.provider_config as Record<string, unknown> | undefined;
  if (!pc || typeof pc !== "object") return;
  const device = pc.device as string | undefined;

  // Default device should be undefined (auto-select).
  if (device === "webgpu" || device === "wasm") {
    delete pc.device;
    return;
  }
}

async function findModelForProvider(provider: string): Promise<ModelSearchResultItem | undefined> {
  async function runSearch(query: string) {
    try {
      return await modelSearch({ provider, query });
    } catch {
      console.log(`No search function registered for provider "${provider}".`);
      return undefined;
    }
  }

  // For HF-based providers, use the interactive search select
  const HF_PROVIDERS = ["HF_INFERENCE", "HF_TRANSFORMERS_ONNX", "LOCAL_LLAMACPP"];
  const placeholders: Record<string, string> = {
    HF_INFERENCE: "Search HuggingFace models",
    HF_TRANSFORMERS_ONNX: "Search ONNX models",
    LOCAL_LLAMACPP: "Search GGUF models",
  };

  if (HF_PROVIDERS.includes(provider)) {
    const selected = await renderSearchSelect<ModelSearchSelectItem>({
      placeholder: placeholders[provider] ?? "Search models",
      onSearch: async (query, _cursor) => {
        const result = await runSearch(query);
        if (!result) {
          return { items: [], nextCursor: undefined };
        }
        const items: ModelSearchSelectItem[] = result.results.map((item) => ({
          id: item.id,
          label: item.label,
          description: item.description,
          result: item,
        }));
        return { items, nextCursor: undefined };
      },
    });
    return selected?.result;
  }

  // SDK or static list providers — fetch all and use select prompt
  const result = await runSearch("");
  if (!result) return undefined;
  if (!result.results || result.results.length === 0) {
    console.log("No models available for this provider.");
    return undefined;
  }

  const options = result.results.map((item) => ({
    label: item.label,
    value: item.id,
  }));
  const selectedId = await renderSelectPrompt(options, `Select ${provider} model:`);
  if (!selectedId) return undefined;

  return result.results.find((item) => item.id === selectedId);
}

/**
 * Narrow the dtype enum in a provider schema to only show available dtypes.
 * Returns a new schema object (shallow copy) with the dtype enum replaced.
 */
function narrowDtypeEnum(
  schema: DataPortSchemaObject,
  availableDtypes: string[]
): DataPortSchemaObject {
  const pc = schema.properties?.provider_config;
  if (!pc || typeof pc === "boolean" || pc.type !== "object") return schema;
  const dtypeProp = pc.properties?.dtype;
  if (!dtypeProp || typeof dtypeProp === "boolean") return schema;

  const withAuto = ["auto", ...availableDtypes.filter((d) => d !== "auto")];
  const newDtype = { ...dtypeProp, enum: withAuto };
  const newPcProps = { ...pc.properties, dtype: newDtype };
  const newPc = { ...pc, properties: newPcProps };
  const newProps = { ...schema.properties, provider_config: newPc };
  return { ...schema, properties: newProps };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerModelCommand(program: Command): void {
  const model = program.command("model").description("Manage models");

  model
    .command("list")
    .description("List all registered models")
    .action(async () => {
      const config = await loadConfig();
      const repo = createModelRepository(config);
      await repo.setupDatabase();

      const models = await repo.enumerateAllModels();
      if (!models || models.length === 0) {
        console.log("No models found.");
        return;
      }

      const rows = models.map((m) => ({
        model_id: m.model_id,
        provider: m.provider,
        title: m.title ?? "",
        description: m.description ?? "",
      }));
      console.log(formatTable(rows, ["model_id", "provider", "title", "description"]));
    });

  model
    .command("detail")
    .argument("[id]", "model ID to show")
    .description("Show full details of a model")
    .action(async (id: string | undefined) => {
      const config = await loadConfig();
      const repo = createModelRepository(config);
      await repo.setupDatabase();

      let targetId = id;
      if (!targetId) {
        if (!process.stdin.isTTY) {
          console.error("Error: specify an id or run interactively.");
          process.exit(1);
        }
        const models = await repo.enumerateAllModels();
        if (!models || models.length === 0) {
          console.log("No models found.");
          return;
        }
        const options = models.map((m) => ({
          label: `${m.model_id}  ${m.provider}  ${m.title ?? ""}`,
          value: m.model_id,
        }));
        const selected = await renderSelectPrompt(options, "Select model:");
        if (!selected) return;
        targetId = selected;
      }

      const model = await repo.findByName(targetId);
      if (!model) {
        console.error(`Model "${targetId}" not found.`);
        process.exit(1);
      }

      console.log(JSON.stringify(model, null, 2));
    });

  model
    .command("remove")
    .argument("[id]", "model ID to remove")
    .description("Remove a model by ID")
    .action(async (id: string | undefined) => {
      const config = await loadConfig();
      const repo = createModelRepository(config);
      await repo.setupDatabase();

      let targetId = id;
      if (!targetId) {
        if (!process.stdin.isTTY) {
          console.error("Error: specify an id or run interactively.");
          process.exit(1);
        }
        const models = await repo.enumerateAllModels();
        if (!models || models.length === 0) {
          console.log("No models to remove.");
          return;
        }
        const options = models.map((m) => ({
          label: `${m.model_id}  ${m.provider}  ${m.title ?? ""}`,
          value: m.model_id,
        }));
        const selected = await renderSelectPrompt(options, "Select model to remove:");
        if (!selected) return;
        targetId = selected;
      }

      try {
        await repo.removeModel(targetId);
        console.log(`Model "${targetId}" removed.`);
      } catch (e: unknown) {
        console.error((e as Error).message);
        process.exit(1);
      }
    });

  const add = model
    .command("add")
    .description("Add a new model")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .helpOption(false)
    .option("--input-json <json>", "Input as JSON string")
    .option("--input-json-file <path>", "Input from JSON file")
    .option("--dry-run", "Validate input without saving")
    .option("--help", "Show help (provider-aware if -provider given)")
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      const provider = detectProviderFromArgv(process.argv);
      const schema: DataPortSchemaObject =
        provider && PROVIDER_SCHEMAS[provider] ? PROVIDER_SCHEMAS[provider] : ModelRecordSchema;

      if (opts.help) {
        add.outputHelp();
        console.log("\nInput flags (from model schema):");
        console.log(generateSchemaHelpText(schema));
        console.log(`\nAvailable providers: ${AVAILABLE_PROVIDERS.join(", ")}`);
        process.exit(0);
      }

      const dynamicFlags = parseDynamicFlags(process.argv, schema);
      const input = await resolveInput({
        inputJson: opts.inputJson as string | undefined,
        inputJsonFile: opts.inputJsonFile as string | undefined,
        dynamicFlags,
        schema,
      });

      let withDefaults = applySchemaDefaults(input, schema);

      if (process.stdin.isTTY) {
        withDefaults = await promptMissingInput(withDefaults, schema);
      }

      normalizeHfTransformersOnnxDevice(withDefaults as Record<string, unknown>);

      const validation = validateInput(withDefaults, schema);
      if (!validation.valid) {
        console.error("Input validation failed:");
        for (const err of validation.errors) {
          console.error(`  - ${err}`);
        }
        process.exit(1);
      }

      if (opts.dryRun) {
        console.log(JSON.stringify(withDefaults, null, 2));
        process.exit(0);
      }

      const config = await loadConfig();
      const repo = createModelRepository(config);
      await repo.setupDatabase();

      await repo.addModel(withDefaults as unknown as ModelRecord);
      console.log(`Model "${String(withDefaults.model_id)}" added.`);
    });

  model
    .command("edit")
    .argument("[id]", "model ID to edit")
    .description(
      "Edit model JSON in $GIT_EDITOR, $VISUAL, or $EDITOR; save to apply, or quit without saving to cancel"
    )
    .action(async (id: string | undefined) => {
      const config = await loadConfig();
      const repo = createModelRepository(config);
      await repo.setupDatabase();

      let targetId = id;
      if (!targetId) {
        if (!process.stdin.isTTY) {
          console.error("Error: specify an id or run interactively.");
          process.exit(1);
        }
        const models = await repo.enumerateAllModels();
        if (!models || models.length === 0) {
          console.log("No models found.");
          return;
        }
        const options = models.map((m) => ({
          label: `${m.model_id}  ${m.provider}  ${m.title ?? ""}`,
          value: m.model_id,
        }));
        const selected = await renderSelectPrompt(options, "Select model to edit:");
        if (!selected) return;
        targetId = selected;
      }

      const existing = await repo.findByName(targetId);
      if (!existing) {
        console.error(`Model "${targetId}" not found.`);
        process.exit(1);
      }

      const initial = JSON.stringify(existing, null, 2);

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

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(result.content) as Record<string, unknown>;
      } catch (e) {
        console.error(`Invalid JSON: ${formatError(e)}`);
        process.exit(1);
      }

      if (asText(parsed.model_id) !== targetId) {
        console.error(`model_id must remain "${targetId}" when editing this entry.`);
        process.exit(1);
      }

      const provider = parsed.provider as string;
      const schema: DataPortSchemaObject = PROVIDER_SCHEMAS[provider] ?? ModelRecordSchema;

      normalizeHfTransformersOnnxDevice(parsed);

      const validation = validateInput(parsed, schema);
      if (!validation.valid) {
        console.error("Validation failed:");
        for (const err of validation.errors) {
          console.error(`  - ${err}`);
        }
        process.exit(1);
      }

      await repo.updateModel(parsed as unknown as ModelRecord);
      console.log(`Model "${targetId}" saved.`);
    });

  model
    .command("find")
    .argument("[query]", "Initial search term (HuggingFace providers only)")
    .option("--dry-run", "Validate and print result without saving")
    .description("Search for a model and add it")
    .action(async (_query: string | undefined, opts: { dryRun?: boolean }) => {
      if (!process.stdin.isTTY) {
        console.error("Error: model find requires an interactive terminal.");
        process.exit(1);
      }

      // Step 1: Pick provider
      const providerOptions = AVAILABLE_PROVIDERS.map((p) => ({ label: p, value: p }));
      const selectedProvider = await renderSelectPrompt(providerOptions, "Select provider:");
      if (!selectedProvider) return;

      // Step 2: Find model for that provider
      const result = await findModelForProvider(selectedProvider);
      if (!result) return;

      // Step 3: Map to partial input and run add form
      let input = result.record;

      let schema: DataPortSchemaObject = PROVIDER_SCHEMAS[selectedProvider] ?? ModelRecordSchema;

      // For ONNX models, narrow dtype enum to available dtypes from search results
      if (selectedProvider === "HF_TRANSFORMERS_ONNX") {
        const pc = input.provider_config;
        const quantizations = pc?.quantizations as string[] | undefined;
        if (quantizations && quantizations.length > 0) {
          schema = narrowDtypeEnum(schema, quantizations);
          // Remove quantizations from the record before saving (not part of model schema)
          delete pc!.quantizations;
        } else if (result.raw) {
          // Fallback: parse from raw entry if siblings available
          const raw = result.raw as { siblings?: Array<{ rfilename: string }> };
          if (raw.siblings && raw.siblings.length > 0) {
            const filePaths = raw.siblings.map((s) => s.rfilename);
            const dtypes = parseOnnxQuantizations({ filePaths });
            if (dtypes.length > 0) {
              schema = narrowDtypeEnum(schema, dtypes);
            }
          }
        }
      }

      let withDefaults = applySchemaDefaults(input, schema);

      // Present the full editable form pre-populated with found data
      withDefaults = await promptEditableInput(withDefaults, schema);

      normalizeHfTransformersOnnxDevice(withDefaults as Record<string, unknown>);

      const validation = validateInput(withDefaults, schema);
      if (!validation.valid) {
        console.error("Input validation failed:");
        for (const err of validation.errors) {
          console.error(`  - ${err}`);
        }
        process.exit(1);
      }

      if (opts.dryRun) {
        console.log(JSON.stringify(withDefaults, null, 2));
        process.exit(0);
      }

      const config = await loadConfig();
      const repo = createModelRepository(config);
      await repo.setupDatabase();

      await repo.addModel(withDefaults as unknown as ModelRecord);
      console.log(`Model "${String(withDefaults.model_id)}" added.`);
    });
}
