# @workglow/deepseek

DeepSeek provider for @workglow/ai.

DeepSeek exposes an OpenAI-compatible REST API, so this provider reuses the
`openai` SDK pointed at `https://api.deepseek.com`. It covers the DeepSeek chat
models (text generation, tool use, structured/JSON output, rewriting,
summarization).

## Features

- Integration with the DeepSeek API for Workglow AI tasks
- Supports standard Workglow AI task interfaces
- Works seamlessly with `@workglow/task-graph` and `@workglow/ai`
- Built-in job queue support for rate limiting and concurrency

## Installation

```bash
npm install @workglow/deepseek
# or
bun add @workglow/deepseek
# or
yarn add @workglow/deepseek
```

## Usage

```typescript
import { registerDeepSeekInline } from "@workglow/deepseek/ai-runtime";
import { getGlobalModelRepository } from "@workglow/ai";
import { DEEPSEEK } from "@workglow/deepseek/ai";
import { TextGenerationTask } from "@workglow/ai";
import { Workflow } from "@workglow/task-graph";

// 1. Register the provider (reads DEEPSEEK_API_KEY from the environment)
await registerDeepSeekInline();

// 2. Register a DeepSeek model
await getGlobalModelRepository().addModel({
  model_id: "deepseek:deepseek-flash",
  title: "DeepSeek Flash",
  description: "DeepSeek Flash",
  capabilities: ["text.generation", "tool-use", "json-mode"],
  provider: DEEPSEEK,
  provider_config: { model_name: "deepseek-flash" },
  metadata: {},
});

// 3. Use it in a workflow
const workflow = new Workflow();
workflow.addTask(TextGenerationTask, {
  model: "deepseek:deepseek-flash",
  prompt: "Hello world!",
});

const result = await workflow.run();
```

## License

Apache 2.0 - See [LICENSE](../../LICENSE) for details.
