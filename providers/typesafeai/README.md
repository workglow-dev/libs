# @workglow/typesafeai

TypeSafe provider for @workglow/ai.

[TypeSafe](https://typesafe.ai)'s Jev is a **System One** model: it does not
write text. You send it a `state` plus a map of named, typed questions and it
returns one typed answer per question — a probability, a selected option with
its full distribution, or a position on a rubric you define. Code keeps the
workflow; the model supplies the semantic judgment ordinary code cannot.

## What this provider serves

| Capability            | Task                     | How it maps                                                        |
| --------------------- | ------------------------ | ------------------------------------------------------------------ |
| `judgment.systemone`  | `SystemOneTask`          | The native surface — many typed questions over one state, one call |
| `text.classification` | `TextClassificationTask` | One Choice over `candidateLabels`; probabilities become scores     |
| `text.reranking`      | `TextRerankerTask`       | One Noul per candidate; the noul is the relevance score            |
| `model.search`        | `ModelSearchTask`        | `GET /v1/models`                                                   |
| `model.info`          | `ModelInfoTask`          | Local record; see the note below                                   |

There is **no** text generation, tool calling, JSON mode, embedding or image
support, and the provider never infers those capabilities for a model — a record
claiming one would pass the task's capability gate and then fail inside the
provider.

Two behaviours worth knowing before you rely on them:

- **Classification is always zero-shot.** There is no trained label vocabulary
  to fall back on, so `candidateLabels` is required rather than optional, and
  blank or duplicate labels are refused rather than silently collapsed.
- **Reranking is one request per candidate.** That is the vendor's own recipe
  and it is what keeps the scores independent: batching a shortlist into one
  call would put every candidate in the state each question reads, so a
  passage's score would depend on what it was ranked beside. The fan-out runs
  `provider_config.rerank_concurrency` at a time (default 8) to stay inside the
  account's requests-per-minute limit, and the reported usage is the sum across
  every request.
- **`model.info` makes no existence check.** `GET /v1/models` lists only the
  aliases, and the vendor states a versioned id such as `jev-1.13.0` is accepted
  whether or not it appears there — so checking against that list would reject
  the exact ids you are told to pin.

## Installation

```bash
npm install @workglow/typesafeai
# or
bun add @workglow/typesafeai
# or
yarn add @workglow/typesafeai
```

## Usage

```typescript
import { registerTypeSafeAiInline } from "@workglow/typesafeai/ai-runtime";
import { getGlobalModelRepository, SystemOneTask } from "@workglow/ai";
import { TYPESAFEAI } from "@workglow/typesafeai/ai";
import { Workflow } from "@workglow/task-graph";

// 1. Register the provider (reads TYPESAFE_API_KEY from the environment)
await registerTypeSafeAiInline();

// 2. Register a TypeSafe model
await getGlobalModelRepository().addModel({
  model_id: "typesafe:jev-latest",
  title: "Jev",
  description: "TypeSafe System One",
  capabilities: ["judgment.systemone", "text.classification", "text.reranking"],
  provider: TYPESAFEAI,
  provider_config: { model_name: "jev-latest" },
  metadata: {},
});

// 3. Ask every independent question of the same state in ONE run. The model
//    reads the state once and answers them in parallel, so eight questions
//    here cost a fraction of eight runs asking one.
const workflow = new Workflow();
workflow.addTask(SystemOneTask, {
  model: "typesafe:jev-latest",
  state: { ticket: "I was charged twice. Please fix this ASAP." },
  questions: {
    urgent: {
      type: "noul",
      instructions: "Does this convey urgency?",
      criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" },
    },
    department: {
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: {
        billing: "Payments, invoicing, refunds",
        technical: "Bugs, outages, integrations",
        sales: "Pricing, upgrades, new accounts",
      },
    },
    frustration: {
      type: "score",
      instructions: "How frustrated is the customer?",
      criteria: ["Calm", "Frustrated", "Very angry"],
    },
  },
});

const { answers } = await workflow.run();
answers.urgent.noul; // 0.92
answers.department.choice; // "billing"
answers.department.confidence; // 0.82
answers.frustration.score; // 1.6 — can land between levels
```

### Reading the answers

- A **noul** is the probability the answer is yes, not a boolean. A value near
  0.5 means "similar probability either way", not "medium intensity".
- **Confidence** (Choice and Score) summarises how concentrated the distribution
  is. It tells you whether to act on the answer, not whether the answer is
  correct, and low confidence on a harmless preference is not a failure.
- Thresholds belong in your code, evaluated against your data and the cost of
  being wrong. Keep the raw judgments so changing a weight or a cutoff does not
  mean re-running inference.

## Configuration

`provider_config` accepts:

| Field                | Meaning                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `model_name`         | Required. `jev-latest`, `jev-preview`, or a pinned id like `jev-1.13.0`.       |
| `credential_key`     | Key to look up in the credential store; otherwise `TYPESAFE_API_KEY` is read.  |
| `base_url`           | Defaults to `https://api.typesafe.ai`. Host-validated before the key is sent.  |
| `trustedBaseUrl`     | Opt out of host validation for a known-good gateway. See the schema's warning. |
| `rerank_concurrency` | Candidates scored at once during a rerank. Default 8.                          |

An alias moves when a release ships, so pin the versioned id on a model whose
confidence thresholds you have tuned against that version.

## License

Apache 2.0 - See [LICENSE](../../LICENSE) for details.
