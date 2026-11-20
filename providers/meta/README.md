# @workglow/meta

Meta Model API provider for @workglow/ai.

The Meta Model API (`https://api.meta.ai/v1`) serves Meta's Muse models over an
OpenAI-compatible chat-completions surface, so this provider reuses the `openai`
SDK pointed at it. It covers the Muse chat models (Muse Spark, Muse Wonder,
Muse Ember, and the Spark contributor variants): text generation, tool use,
structured JSON output, rewriting, summarization, vision input, and the
reasoning-effort dial.

It replaces Meta's earlier Llama API (`api.llama.com`), which Meta retired in
July 2026. Llama-era model ids are not recognized.

## What the API accepts

The Meta Model API is stricter than OpenAI's, and the provider shapes requests
to match:

- **`tool_choice`**: only `auto` is accepted. `toolChoice: "none"` is honored by
  sending no tools. `"required"` and a named tool are refused before the request
  is sent, because the API has no way to force a call.
- **Sampling**: `frequency_penalty`, `presence_penalty` and `stop` are rejected by
  the API and never sent. `temperature` and `top_p` are mutually exclusive, so
  `temperature` wins when both are set.
- **Reasoning effort**: no Muse model accepts `none`, so the coarse dial offers
  `low`, `medium`, `high` and `extra` (sent as `xhigh`), plus `ultra` (sent as
  `max`) on the models that take it: Muse Wonder, Muse Ember and Muse Spark 1.3,
  but not the contributor variants. Set `provider_config.reasoning_effort` to send
  a native value such as `minimal`.
- **Structured output**: sent as `response_format: json_schema`, strict when the
  schema fits the strict subset and `strict: false` otherwise.
- **Images**: accepted only in user messages, so a tool result's images go in a
  user message after it.
- **Token counts** are approximated with tiktoken. Meta publishes no tokenizer.

## Installation

```bash
npm install @workglow/meta
# or
bun add @workglow/meta
# or
yarn add @workglow/meta
```

## Usage

```typescript
import { registerMetaInline } from "@workglow/meta/ai-runtime";
import { getGlobalModelRepository } from "@workglow/ai";
import { META } from "@workglow/meta/ai";
import { TextGenerationTask } from "@workglow/ai";
import { Workflow } from "@workglow/task-graph";

// 1. Register the provider. It reads META_API_KEY, then MODEL_API_KEY (the name
//    Meta's docs use), unless a model sets provider_config.credential_key.
await registerMetaInline();

// 2. Register a Muse model
await getGlobalModelRepository().addModel({
  model_id: "meta:muse-spark-1.3",
  title: "Muse Spark 1.3",
  description: "Meta Muse Spark 1.3",
  capabilities: ["text.generation", "tool-use", "json-mode", "vision-input"],
  provider: META,
  provider_config: { model_name: "muse-spark-1.3" },
  metadata: {},
});

// 3. Use it in a workflow
const workflow = new Workflow();
workflow.addTask(TextGenerationTask, {
  model: "meta:muse-spark-1.3",
  prompt: "Hello world!",
});

const result = await workflow.run();
```

## License

Apache 2.0 - See [LICENSE](../../LICENSE) for details.
