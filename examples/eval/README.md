# Workglow Eval Example

A command-line harness for comparing AI models on Workglow task workflows, using
HuggingFace datasets as ground truth and Workglow storage for every artifact —
dataset rows, eval runs, and per-row results all live in a queryable SQLite
database.

## Overview

The [`@workglow/sec`](https://github.com/workglow-dev/sec) project ships an eval
harness specialized for SEC filing extraction. This example is the
general-purpose version of that idea:

1. **Pull** a dataset split from HuggingFace into tabular storage.
2. **Run** each stored row through a task workflow, once per candidate model.
3. **Score** the stored results and rank the models on quality and latency.

Because every step reads from and writes to `ITabularStorage`, runs are
inspectable and repeatable: re-score without re-running, diff two runs, or point
another tool at the same SQLite file.

## Getting Started

```bash
bun install
bun run build-example

# 1. Pull a dataset split into storage
./dist/workglow-eval.js dataset pull dair-ai/emotion --split test --limit 100
./dist/workglow-eval.js dataset list

# 2. Run an eval workflow across models (per-row workflow × models)
./dist/workglow-eval.js run-classify --dataset dair-ai/emotion --split test \
  --models "onnx-community/LFM2.5-350M-ONNX,claude-haiku-4-5,gpt-5.4-mini"

# 3. Re-score any stored run later
./dist/workglow-eval.js runs
./dist/workglow-eval.js report [run-id] --format json
```

Everything is stored under `~/.workglow/eval` (override with
`WORKGLOW_EVAL_HOME`). Re-pulling a split replaces it; pulling with `--offset`
extends the stored split, so large splits can be paged in incrementally.

## Eval workflows

### `run-classify` — label accuracy

Each row runs a one-task workflow: `StructuredGenerationTask` with an output
schema whose `label` property is an enum of the candidate labels. Any model
with text generation + JSON mode is comparable — local ONNX models and cloud
models compete on the same rows. Scored by accuracy (case/punctuation
insensitive).

Works out of the box with classification datasets such as `dair-ai/emotion` or
`SetFit/sst2`. Integer-coded label columns are mapped through the dataset's
`ClassLabel` names automatically; use `--labels "a,b,c"` when the dataset
doesn't declare them (integer gold labels are then mapped through that list,
in order).

### `run-similarity` — embedding quality

Each row runs a one-task workflow: `TextEmbeddingTask` embeds a sentence pair,
and the cosine similarity of the two vectors is the model's predicted score.
Scored by Pearson/Spearman correlation against the dataset's gold ratings
(correlation is scale-invariant, so 0–5 ratings work as-is).

Works out of the box with `mteb/stsbenchmark-sts`:

```bash
./dist/workglow-eval.js dataset pull mteb/stsbenchmark-sts --split test --limit 200
./dist/workglow-eval.js run-similarity --dataset mteb/stsbenchmark-sts --split test \
  --models "Xenova/all-MiniLM-L6-v2,text-embedding-3-small"
```

### `run-extract` — structured extraction quality

Each row runs a one-task workflow: `StructuredGenerationTask` with an `items`
array output schema, extracting structured records (people, deals, entities…)
from the row's prose. The gold column (`--expected-column`, default
`expected`) holds an array of objects — parquet struct/list columns and JSON
strings both work. Candidate items are aligned to gold rows by
`--key-field` (default `name`, case/punctuation-insensitive) and scored on
three axes, micro-averaged across the split:

- **score** — field-level agreement over matched rows, excluding the key
  field itself (a matched pair agrees on it by construction). The ranking
  metric; falls back to **found** when no fields were scored.
- **found** — entity recall (gold rows matched by key)
- **prec** — precision over distinct candidate rows (1 − hallucinated rows)

`--fields "a,b,c"` limits which fields are requested and scored (default: the
keys seen in the gold rows); `--instruction "…"` replaces the task sentence at
the top of the prompt.

```bash
./dist/workglow-eval.js run-extract --dataset my-org/people-extraction --split test \
  --key-field name --fields "name,role" \
  --instruction "Extract every person mentioned in the text." \
  --models "claude-haiku-4-5,onnx-community/LFM2.5-350M-ONNX,gguf:prism-ml/Bonsai-27B-gguf:Q1_0"
```

This is the generalized form of the SEC repo's extraction eval: same
alignment-by-key scoring (a model that emits the same entity twice is
over-producing rows, not hallucinating, so precision is computed over
distinct rows), but driven by any HuggingFace dataset instead of committed
fixtures.

## Model ids

Model ids resolve to an inline `ModelConfig` by shape — no model repository
setup needed:

| Shape                                    | Provider                            |
| ---------------------------------------- | ----------------------------------- |
| `claude-*`                               | Anthropic (`ANTHROPIC_API_KEY`)     |
| `gpt-*`, `o<n>*`, `text-embedding-*`     | OpenAI (`OPENAI_API_KEY`)           |
| `gemini-*`                               | Google Gemini (`GEMINI_API_KEY`)    |
| `grok-*`                                 | xAI (`XAI_API_KEY`)                 |
| `deepseek-*`                             | DeepSeek (`DEEPSEEK_API_KEY`)       |
| `muse-*`                                 | Meta (`META_API_KEY`)               |
| `org/name` (optionally `org/name:dtype`) | Local HuggingFace Transformers ONNX |
| `gguf:org/repo:Quant` or `gguf:*.gguf`   | Local node-llama-cpp (GGUF)         |

Local models download on first use into the eval home's cache and run in a
worker; no API key required. Embedding dimensions for ONNX models are read from
the model's `config.json` on the hub; GGUF references resolve through
node-llama-cpp's `hf:` URIs (an explicit `gguf:` prefix is required because a
GGUF repo id is indistinguishable from an ONNX one). Note that small instruct
models vary widely in JSON mode reliability — `onnx-community/LFM2.5-350M-ONNX`
(the classify default) follows the schema; e.g. SmolLM2-360M echoes the schema
back instead of an answer. A model that fails a row is recorded as a failed
result (visible in the report), never a crashed sweep.

### Bonsai 27B

The Bonsai 27B release (2026-07, Qwen3.6-27B base) is the kind of model this
harness is for — a 1-bit/ternary model whose claim is cloud-class quality at
local cost. Compare it against a cloud model on the same rows:

```bash
./dist/workglow-eval.js run-classify --dataset dair-ai/emotion --split test \
  --models "gguf:prism-ml/Bonsai-27B-gguf:Q1_0,claude-haiku-4-5"
```

The ternary variant is `gguf:prism-ml/Ternary-Bonsai-27B-gguf:Q2_0`. As of the
release only GGUF/MLX/AWQ conversions exist — when `onnx-community` publishes
the 27B ONNX conversion it slots straight in as
`onnx-community/Bonsai-27B-ONNX` (the smaller Bonsai ONNX sizes,
e.g. `onnx-community/Bonsai-8B-ONNX`, work today).

## Dataset fetching

`dataset pull` prefers the HuggingFace datasets viewer API
(`datasets-server.huggingface.co/rows`), which provides typed features and
pagination. When that endpoint is unreachable it falls back to downloading the
repo's data files directly from the hub, parsing parquet (including the
`ClassLabel` names embedded in the parquet footer), `jsonl`, `jsonl.gz`,
`ndjson`, and `json`. Set `HF_TOKEN` for gated or private datasets.

## Storage layout

| Table              | Key                         | Contents                              |
| ------------------ | --------------------------- | ------------------------------------- |
| `eval_dataset`     | (dataset, split)            | columns, ClassLabel names, row count  |
| `eval_dataset_row` | (dataset, split, row_index) | raw row JSON                          |
| `eval_run`         | run_id (uuid)               | kind, dataset, models, column options |
| `eval_result`      | (run_id, model, row_index)  | expected/predicted, latency, ok/error |

The same schemas run on any `ITabularStorage` backend — the unit tests exercise
them with `InMemoryTabularStorage`, the CLI uses `SqliteTabularStorage`.

## Tests

```bash
bun run test          # unit tests (scorers, parsers, storage round-trip)
```

`src/test/liveSimilarity.e2e.test.ts` (ONNX) and `src/test/ggufSmoke.e2e.test.ts`
(GGUF) are live end-to-end checks (network + model download) and are excluded
from the default vitest run like the rest of the repo's `.e2e.test.ts` files.
