/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { withCli } from "@workglow/cli";
import type { StreamEvent } from "@workglow/task-graph";
import { retractionLength, Workflow } from "@workglow/task-graph";
import type { Command } from "commander";
import { EvalSweepTask, type EvalSweepTaskOutput } from "../evals/EvalSweepTask";
import type { ColumnOptions, DatasetContext } from "../evals/types";
import type { LabelNames } from "../hf/types";
import type { EvalKind } from "../models";
import { parseModelList, resolveModelConfig } from "../models";
import { LiveTally } from "../report/liveTally";
import type { EvalStores } from "../storage";
import { formatError, parseIntFlag } from "../util";
import { printReport } from "./report";

const DEFAULT_MODELS: Record<EvalKind, string> = {
  classify: "onnx-community/LFM2.5-350M-ONNX",
  similarity: "Xenova/all-MiniLM-L6-v2",
  extract: "onnx-community/LFM2.5-350M-ONNX",
};

const DEFAULT_TEXT_COLUMN: Record<EvalKind, string> = {
  classify: "text",
  similarity: "sentence1",
  extract: "text",
};

const DESCRIPTIONS: Record<EvalKind, string> = {
  classify:
    "Classify each stored row with each model (StructuredGenerationTask) and score accuracy",
  similarity:
    "Embed stored sentence pairs with each model (TextEmbeddingTask) and correlate cosine similarity with the gold score",
  extract:
    "Extract structured records from each stored row (StructuredGenerationTask) and score field agreement, entity recall, and precision against the gold rows",
};

interface RunFlags {
  readonly dataset: string;
  readonly split: string;
  readonly models?: string | undefined;
  readonly limit?: string | undefined;
  readonly textColumn?: string | undefined;
  readonly labelColumn?: string | undefined;
  readonly labels?: string | undefined;
  readonly pairColumn?: string | undefined;
  readonly scoreColumn?: string | undefined;
  readonly expectedColumn?: string | undefined;
  readonly keyField?: string | undefined;
  readonly fields?: string | undefined;
  readonly instruction?: string | undefined;
  readonly format: string;
  readonly stream: boolean;
}

export function registerRunCommand(
  program: Command,
  openStores: () => Promise<EvalStores>,
  ensureProviders: () => Promise<void>
): void {
  for (const kind of ["classify", "similarity", "extract"] as const) {
    const command = program
      .command(`run-${kind}`)
      .description(DESCRIPTIONS[kind])
      .requiredOption("--dataset <id>", "a dataset previously stored via `dataset pull`")
      .option("--split <split>", "dataset split", "test")
      .option("--models <list>", `comma-separated model ids (default: ${DEFAULT_MODELS[kind]})`)
      .option("--limit <n>", "cap the number of stored rows to run")
      .option("--text-column <name>", `input text column (default: ${DEFAULT_TEXT_COLUMN[kind]})`)
      .option("--format <fmt>", "report output: table or json", "table")
      .option("--stream", "render in-flight generation text for the current row", false);
    if (kind === "classify") {
      command
        .option("--label-column <name>", "gold label column (default: label)")
        .option("--labels <list>", "comma-separated candidate labels override");
    } else if (kind === "similarity") {
      command
        .option("--pair-column <name>", "second sentence column (default: sentence2)")
        .option("--score-column <name>", "gold score column (default: score)");
    } else {
      command
        .option(
          "--expected-column <name>",
          "gold column: array of objects or JSON (default: expected)"
        )
        .option(
          "--key-field <name>",
          "field that identifies an entity when aligning (default: name)"
        )
        .option("--fields <list>", "comma-separated fields to extract and score")
        .option("--instruction <text>", "task sentence at the top of the prompt");
    }
    command.action(async (flags: RunFlags) => {
      try {
        await ensureProviders();
        await runEval(kind, flags, await openStores());
      } catch (err) {
        console.error(`Error: ${formatError(err)}`);
        process.exitCode = 1;
      }
    });
  }
}

/**
 * Split a comma-separated flag, trimming, deduplicating, and dropping empties
 * from stray commas ("a,b," → [a, b]). A flag that was passed but holds no
 * names is an error, not a silent fall-through to the defaults.
 */
function parseNameList(value: string | undefined, flag: string): string[] | undefined {
  if (value === undefined) return undefined;
  const names = [
    ...new Set(
      value
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
    ),
  ];
  if (names.length === 0) throw new Error(`${flag} was given but contains no names`);
  return names;
}

async function runEval(kind: EvalKind, flags: RunFlags, stores: EvalStores): Promise<void> {
  const meta = await stores.datasets.get({ dataset: flags.dataset, split: flags.split });
  if (!meta) {
    throw new Error(
      `dataset ${flags.dataset} [${flags.split}] is not in storage — ` +
        `run \`workglow-eval dataset pull ${flags.dataset} --split ${flags.split}\` first`
    );
  }

  const rows = (await stores.rows.query({ dataset: flags.dataset, split: flags.split })) ?? [];
  rows.sort((a, b) => a.row_index - b.row_index);
  const limit = flags.limit === undefined ? undefined : parseIntFlag(flags.limit, "--limit", 1);
  const limited = limit === undefined ? rows : rows.slice(0, limit);
  if (limited.length === 0) throw new Error("no stored rows to evaluate");

  const models = parseModelList(flags.models ?? DEFAULT_MODELS[kind]);
  const keyField = (flags.keyField ?? "name").trim();
  if (keyField.length === 0) throw new Error("--key-field must not be empty");
  const columns: ColumnOptions = {
    textColumn: flags.textColumn ?? DEFAULT_TEXT_COLUMN[kind],
    labelColumn: flags.labelColumn ?? "label",
    labels: parseNameList(flags.labels, "--labels"),
    pairColumn: flags.pairColumn ?? "sentence2",
    scoreColumn: flags.scoreColumn ?? "score",
    expectedColumn: flags.expectedColumn ?? "expected",
    keyField,
    fields: parseNameList(flags.fields, "--fields"),
    instruction: flags.instruction,
  };
  const context: DatasetContext = {
    columns: JSON.parse(meta.columns) as string[],
    labelNames: meta.label_names ? (JSON.parse(meta.label_names) as LabelNames) : {},
  };

  console.error(
    `running ${kind} over ${limited.length} rows of ${flags.dataset} [${flags.split}] ` +
      `with ${models.length} model(s)`
  );
  const tally = new LiveTally((id) => resolveModelConfig(id, kind).pricing, Date.now());
  const onStreamChunk: ((event: StreamEvent) => void) | undefined = flags.stream
    ? (event) => {
        if (event.type === "text-delta") process.stderr.write(event.textDelta);
        else if (event.type === "text-retract" && retractionLength(event.length) > 0) {
          // Already written, so it cannot be erased: say it no longer counts.
          process.stderr.write(
            `\n[attempt failed; the last ${retractionLength(event.length)} characters are withdrawn]\n`
          );
        }
      }
    : undefined;
  // Through `withCli`, the seam that decides what a run does with itself. It
  // draws nothing here — `interactive: false`, because the tally below owns
  // the terminal — but it is what lets a watching parent (the web console runs
  // commands as child processes) see the sweep at all.
  const sweep = new EvalSweepTask({ title: `${kind} · ${flags.dataset}` }).withSweep(
    stores,
    limited,
    {
      kind,
      dataset: flags.dataset,
      split: flags.split,
      models,
      columns,
      context,
      onProgress: (done, total, model, ok, usage) => {
        tally.record(model, ok, usage);
        process.stderr.write(`${tally.render(done, total, Date.now())}\n`);
      },
      onStreamChunk,
    }
  );
  const workflow = new Workflow();
  workflow.pipe(sweep as never);
  const output = (await withCli(workflow, { interactive: false }).run()) as EvalSweepTaskOutput;
  const runId = output.run_id;

  console.error(`run ${runId} complete\n`);
  await printReport(stores, runId, flags.format);
}
