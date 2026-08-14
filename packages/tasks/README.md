# @workglow/tasks

A package of task types for common operations, workflow management, and data processing. This package provides building blocks for creating complex task graphs with support for HTTP requests, JavaScript execution, delays, logging, and dynamic task creation.

## Table of Contents

- [Table of Contents](#table-of-contents)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Available Tasks](#available-tasks)
  - [FetchUrlTask](#fetchurltask)
  - [WebhookNotifyTask](#webhooknotifytask)
  - [SlackNotifyTask](#slacknotifytask)
  - [DiscordNotifyTask](#discordnotifytask)
  - [DebugLogTask](#debuglogtask)
  - [DelayTask](#delaytask)
  - [JavaScriptTask](#javascripttask)
  - [LambdaTask](#lambdatask)
  - [JsonTask](#jsontask)
  - [ArrayTask](#arraytask)
- [Filesystem Tasks (server builds)](#filesystem-tasks-server-builds)
- [Workflow Integration](#workflow-integration)
- [Error Handling](#error-handling)
- [Configuration](#configuration)
- [Testing](#testing)
- [License](#license)

## Installation

```bash
bun add @workglow/tasks
```

## Quick Start

```typescript
import { Workflow } from "@workglow/tasks";

// Simple workflow example (fluent API)
const workflow = new Workflow()
  .fetch({ url: "https://api.example.com/data", response_type: "json" })
  .debugLog(undefined, { log_level: "info" })
  .delay(undefined, { delay: 1000 });

const results = await workflow.run();
```

```typescript
import { fetchUrl, debugLog, delay } from "@workglow/tasks";

// Simple sequence using the exported helpers
const fetchResult = await fetchUrl({
  url: "https://api.example.com/data",
  response_type: "json",
});

await debugLog({ console: fetchResult.json }, { log_level: "info" });

await delay({}, { delay: 1000 });
```

> **Inputs go to `run()`, not to the constructor.** A task constructor takes
> `(config, runConfig)`, and `TaskConfigSchema` is `additionalProperties: false`,
> so `new SomeTask({ url: "…" })` throws a `TaskConfigurationError` before any
> work happens. Each helper above (`fetchUrl`, `debugLog`, `slackNotify`, …) is
> just `new SomeTask(config).run(input)` with the two arguments in the right
> places. To bake input values into an instance, put them under the config's
> `defaults` key — see the [WebhookNotifyTask](#webhooknotifytask) examples.

```typescript
import { fetch, debugLog, delay } from "@workglow/tasks";

const data = await fetch({
  url: "https://example.com/readme.txt",
  response_type: "text",
});
await debugLog({ console: data.text }, { log_level: "info" });
```

## Available Tasks

### FetchUrlTask

Makes HTTP requests with built-in retry logic, progress tracking, and multiple response types.

**Input Schema:**

- `url` (string, required): The URL to fetch from
- `method` (string, optional): HTTP method ("GET", "POST", "PUT", "DELETE", "PATCH"). Default: "GET"
- `headers` (object, optional): Headers to send with the request
- `body` (string, optional): Request body for POST/PUT requests
- `response_type` (string, **required**): What to materialize from the response — `"stream"`, `"json"`, `"text"`, `"blob"`, or `"arraybuffer"`. `"stream"` materializes nothing: the bytes still reach the `body` port and the output cache, and `metadata.contentType` says what they are. The other values additionally populate the matching derived port. The schema declares no default and there is no Content-Type inference — whether a caller wants the body buffered into memory is theirs to state. (A directly constructed task that states nothing falls back to `"stream"`, because `Task` synthesizes an enum's first member as its default; a queued job payload carrying no `response_type` is rejected outright.)
- `timeout` (number, optional): Request timeout in milliseconds
- `queue` (boolean|string, optional): Queue handling (`false` runs inline when possible, `true` uses the task's default queue, strings target a specific registered queue). Default: `true`

**Output Schema:**

- `json` (any, optional): JSON response data
- `text` (string, optional): Text response data
- `blob` (Blob, optional): Blob response data
- `arraybuffer` (ArrayBuffer, optional): ArrayBuffer response data

**Examples:**

```typescript
// Simple GET request
const response = await fetchUrl({
  url: "https://api.example.com/users",
  response_type: "json",
});
console.log(response.json);

// POST request with headers
const postResponse = await fetchUrl({
  url: "https://api.example.com/users",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer token",
  },
  body: JSON.stringify({ name: "John", email: "john@example.com" }),
  response_type: "json",
});

// Text response
const textResponse = await fetchUrl({
  url: "https://example.com/readme.txt",
  response_type: "text",
});
console.log(textResponse.text);
```

**Features:**

- Automatic retry on 429/503 status codes with Retry-After header support (requires creation of a `@workglow/job-queue` instance)
- Progress tracking for large downloads
- Request timeout handling
- Queue-based rate limiting (requires creation of a `@workglow/job-queue` instance)
- Comprehensive error handling

### WebhookNotifyTask

Sends a JSON payload to a webhook endpoint via HTTP POST.

A webhook URL is treated as a secret throughout all three notification tasks: for
Slack and Discord the token is part of the URL path, so the URL is kept out of the
output schema and error messages report only the endpoint's origin.

**Input Schema:**

- `url` (string, optional): Webhook endpoint to POST to. Kept out of errors and output, but a value set here is stored verbatim in the graph JSON — use `url_credential_key` to keep the secret out of the saved workflow.
- `payload` (object, required): JSON body to send
- `headers` (object, optional): Additional headers, merged over the JSON content type
- `timeout` (number, optional): Request timeout in milliseconds. Default: `30000`
- `allow_private_destination` (boolean, optional): Permit posting to a private/internal/loopback destination. Requires the `network:private` entitlement. Default: `false`
- `url_credential_key` (string, optional): Credential store key whose resolved value is the entire webhook URL — the secret itself, not a bearer token. Takes precedence over `url`. A value that is not an absolute `http(s)` URL (e.g. a bearer token) is rejected with a configuration error.

**Output Schema:**

- `success` (boolean): Always `true`; a non-2xx response throws
- `status` (number): HTTP status code returned by the endpoint
- `response` (string): Response body, truncated to 1KB. Always empty for a private/internal destination

**Examples:**

```typescript
// Direct task usage
const result = await webhookNotify({
  url: "https://example.com/hooks/abc123",
  payload: { event: "deploy", version: "1.4.2" },
  headers: { "X-Signature": "sha256=..." },
});
console.log(result.status);

// Config vs. input: the constructor takes CONFIG, so a fixed endpoint belongs
// under `defaults` — the per-run payload is still passed to `run()`.
const notifier = new WebhookNotifyTask({
  title: "Deploy hook",
  defaults: { url: "https://example.com/hooks/abc123" },
});
await notifier.run({ payload: { event: "deploy", version: "1.4.2" } });

// In a workflow
const workflow = new Workflow()
  .fetch({ url: "https://api.example.com/build" })
  .webhookNotify({ url: "https://example.com/hooks/abc123", payload: { event: "build" } });
```

**Features:**

- Runs inline through the SSRF-aware `safeFetch` wrapper
- **Redirects are refused** — a webhook that answers `3xx` fails rather than re-sending the payload and headers to the new origin. Point `url` at the final endpoint
- **A private/internal destination is refused unless `allow_private_destination` is set** — which also declares the `network:private` entitlement, scoped to `url` when no credential key is configured. Without the flag the post fails with `PRIVATE_DENIED` before any request is made, and, when an entitlement enforcer is registered, the `network:private` grant is re-checked at execute time against the URL actually resolved — so a run-input or credential-supplied private destination cannot slip past the declaration the enforcer graded
- A permitted private/internal destination is reachable but its response body is **never echoed** — `response` is always `""`. Notification needs no reply body, and returning one would make this task an SSRF read primitive (e.g. POSTing to a cloud metadata endpoint and reading the answer back into the graph)
- 429/503 and 5xx raise `RetryableJobError`; retries require a `@workglow/job-queue` consumer, which these inline tasks do not have
- Response bodies are read as a stream and abandoned past 1MB, so an endpoint answering with an unbounded body cannot exhaust runner memory — on the failure path too
- Requests time out after 30s by default (`timeout`); a caller abort surfaces as an abort error rather than a retryable network failure
- A configured `url_credential_key` upgrades the `credential` entitlement from optional to enforced
- Never cached — the task is side-effecting (`cachePolicy: { kind: "none" }`)

### SlackNotifyTask

Sends a message to a Slack incoming webhook.

**Input Schema:**

- `url` (string, optional): Slack incoming webhook URL. Kept out of errors and output, but a value set here is stored verbatim in the graph JSON — use `url_credential_key` to keep the secret out of the saved workflow.
- `text` (string, required): Message text, also used as the notification fallback for block messages
- `blocks` (array, optional): Slack Block Kit blocks
- `username` (string, optional): Overrides the display name of the posting bot
- `icon_emoji` (string, optional): Overrides the bot icon, e.g. `:rocket:`
- `allow_mentions` (boolean, optional): Send `text` unmodified. Default: `false`
- `timeout` (number, optional): Request timeout in milliseconds. Default: `30000`
- `allow_private_destination` (boolean, optional): Permit posting to a private/internal/loopback destination. Requires the `network:private` entitlement. Default: `false`
- `url_credential_key` (string, optional): Credential store key whose resolved value is the entire webhook URL — the secret itself, not a bearer token. Takes precedence over `url`.

**Output Schema:**

- `success` (boolean): Always `true`; a non-2xx response throws
- `status` (number): HTTP status code returned by Slack

**Examples:**

```typescript
// Plain message
await slackNotify({
  url: "https://hooks.slack.com/services/T000/B000/xxx",
  text: "Deploy finished",
});

// Block Kit message with a bot identity
await slackNotify({
  url: "https://hooks.slack.com/services/T000/B000/xxx",
  text: "Deploy finished",
  blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Deploy finished*" } }],
  username: "deploybot",
  icon_emoji: ":rocket:",
});

// In a workflow
const workflow = new Workflow().slackNotify({
  url: "https://hooks.slack.com/services/T000/B000/xxx",
  text: "Pipeline complete",
});
```

**Features:**

- Absent optional fields are omitted from the payload rather than sent as `null`
- **Redirects are refused** — a webhook that answers `3xx` fails rather than re-sending the payload and headers to the new origin. Point `url` at the final endpoint
- **A private/internal destination is refused unless `allow_private_destination` is set**, which also declares the `network:private` entitlement, and, when an entitlement enforcer is registered, the `network:private` grant is re-checked at execute time against the URL actually resolved — so a run-input or credential-supplied private destination cannot slip past the declaration the enforcer graded
- Slack answers `200` with the body `ok`; failure bodies (`invalid_payload`, `no_service`) are surfaced in the error message — but **only for a public destination**. A private/internal endpoint's reply body is never spliced into the error, which would otherwise make the task an SSRF read primitive; its status is still reported
- **Channel-wide broadcasts in `text` and `blocks` are neutralized by default**, by two mechanisms, because Slack has two ways to say the same thing. _Lexical:_ Slack has no `allowed_mentions`; its documented control is HTML-entity escaping, so the literal `<!` is escaped to `&lt;!`. That defuses `<!channel>`, `<!here>`, `<!everyone>` and `<!subteam^ID>` while leaving `<https://…|label>` links, single-user `<@U123>` mentions and Slack's `<!date^…>` formatting token intact, and `link_names: false` is sent explicitly. `<!` is Slack's control-sequence sigil rather than a broadcast sigil, and the date token is its one member that can notify nobody, so it is exempted from the escape — escaping it would show the raw token instead of a localized date, recoverable only by turning mentions back on. `blocks` is walked to every string leaf, so a broadcast written inside a section, a `fields[]` entry or an `elements[]` entry is defused too. _Structural:_ a `rich_text` message expresses the same ping as an element shape with no `<!` in it at all — `{type: "broadcast", range: "channel"}` or `{type: "usergroup", usergroup_id: "S…"}` — so such an element is rewritten to a plain text node (`@channel`) rather than deleted, since dropping it could leave an `elements[]` empty and Slack rejects that. Residual: a new structural notification element type Slack introduces later is uncovered until it is added to the recognized set. Set `allow_mentions: true` to send both verbatim
- Requests time out after 30s by default (`timeout`)
- Response bodies are capped at 1MB while being read
- Webhook token never appears in error messages, `error.url`, `error.stack`, or task output

### DiscordNotifyTask

Sends a message to a Discord webhook.

**Input Schema:**

- `url` (string, optional): Discord webhook URL. Kept out of errors and output, but a value set here is stored verbatim in the graph JSON — use `url_credential_key` to keep the secret out of the saved workflow.
- `content` (string, required): Message content
- `username` (string, optional): Overrides the display name of the webhook
- `avatar_url` (string, optional): Overrides the avatar of the webhook
- `embeds` (array, optional): Discord embed objects
- `allow_mentions` (boolean, optional): Let the message ping. Default: `false`
- `timeout` (number, optional): Request timeout in milliseconds. Default: `30000`
- `allow_private_destination` (boolean, optional): Permit posting to a private/internal/loopback destination. Requires the `network:private` entitlement. Default: `false`
- `url_credential_key` (string, optional): Credential store key whose resolved value is the entire webhook URL — the secret itself, not a bearer token. Takes precedence over `url`.

**Output Schema:**

- `success` (boolean): Always `true`; a non-2xx response throws
- `status` (number): HTTP status code returned by Discord, `204` on success

**Examples:**

```typescript
// Plain message
await discordNotify({
  url: "https://discord.com/api/webhooks/123/xxx",
  content: "Build passed",
});

// Embed with a custom identity
await discordNotify({
  url: "https://discord.com/api/webhooks/123/xxx",
  content: "Build passed",
  username: "ci",
  avatar_url: "https://example.com/ci.png",
  embeds: [{ title: "workglow", description: "All checks green" }],
});

// In a workflow
const workflow = new Workflow().discordNotify({
  url: "https://discord.com/api/webhooks/123/xxx",
  content: "Pipeline complete",
});
```

**Features:**

- A successful post answers `204 No Content`, so no response body is read or parsed
- **Redirects are refused** — a webhook that answers `3xx` fails rather than re-sending the payload and headers to the new origin. Point `url` at the final endpoint
- **A private/internal destination is refused unless `allow_private_destination` is set**, which also declares the `network:private` entitlement, and, when an entitlement enforcer is registered, the `network:private` grant is re-checked at execute time against the URL actually resolved — so a run-input or credential-supplied private destination cannot slip past the declaration the enforcer graded
- A failure body is surfaced in the error message **only for a public destination**; a private/internal endpoint's reply body is never spliced in, which would otherwise make the task an SSRF read primitive
- Rate limits arrive as `429` and may carry the delay as `{"retry_after": <seconds>}` in the body instead of a `Retry-After` header; both are parsed onto the raised `RetryableJobError`. Nothing acts on the value — retries require a `@workglow/job-queue` consumer, which these inline tasks do not have
- **Mass mentions are suppressed by default** — `allowed_mentions: { parse: [] }` is sent, so `@everyone`/`@here`, role and user pings in `content` do nothing even when the content was piped in from a fetch or a model. Set `allow_mentions: true` to let the message ping
- Requests time out after 30s by default (`timeout`)
- Response bodies are capped at 1MB while being read
- Webhook token never appears in error messages, `error.url`, `error.stack`, or task output

### DebugLogTask

Provides console logging functionality with multiple log levels for debugging task graphs.

**Input Schema:**

- Any inputs are accepted and passed through to outputs unchanged.

**Config Schema:**

- `log_level` (string, optional): Log level ("dir", "log", "debug", "info", "warn", "error"). Default: "log"

**Output Schema:**

- All inputs passed through unchanged.

**Examples:**

```typescript
// Basic logging
await new DebugLogTask({ console: "Processing user data" }, { log_level: "info" }).run();

// Object inspection with dir
await new DebugLogTask(
  { console: { user: { id: 1, name: "John" }, status: "active" } },
  { log_level: "dir" }
).run();

// In workflow with data flow
const workflow = new Workflow()
  .fetch({ url: "https://api.example.com/data", response_type: "json" })
  .debugLog(undefined, { log_level: "dir" }) // Logs the fetched data
  .delay(undefined, { delay: 1000 });
```

**Features:**

- Multiple log levels for different debugging needs
- Deep object inspection with `dir` level
- Pass-through functionality preserves data flow
- Non-cacheable for real-time debugging

### DelayTask

Introduces timed delays in workflows with progress tracking and cancellation support.

**Input Schema:**

- Any inputs are accepted and passed through to outputs unchanged.

**Config Schema:**

- `delay` (number, optional): Delay duration in milliseconds. Default: 1

**Output Schema:**

- All inputs passed through unchanged.

**Examples:**

```typescript
// Simple delay
await new DelayTask({}, { delay: 5000 }).run(); // 5 second delay

// Delay with data pass-through
const result = await new DelayTask(
  { message: "Data preserved through delay" },
  { delay: 3000 }
).run();
console.log(result); // { message: "Data preserved through delay" }

// In workflow
const workflow = new Workflow()
  .fetch({ url: "https://api.example.com/data", response_type: "json" })
  .delay(undefined, { delay: 2000 }) // 2 second delay
  .debugLog(undefined, { log_level: "info" });
```

**Features:**

- Progress tracking for delays over 100ms
- Cancellation support via AbortSignal
- Chunked delay execution for responsiveness
- All inputs passed through to outputs

### JavaScriptTask

Executes JavaScript code strings using a safe interpreter with input/output handling.

**Input Schema:**

- `code` (string, required): JavaScript code to execute
- `input` (any, optional): Input data available to the code

**Output Schema:**

- `output` (any): The result of the JavaScript execution

**Examples:**

```typescript
// Simple calculation
const result = await JavaScript({
  code: "2 + 3 * 4",
});
console.log(result.output); // 14

// Using input data
const processed = await new JavaScriptTask({
  code: `
    const numbers = input.values;
    const sum = numbers.reduce((a, b) => a + b, 0);
    const average = sum / numbers.length;
    return { sum, average, count: numbers.length };
  `,
  input: { values: [1, 2, 3, 4, 5] },
}).run();
console.log(processed.output); // { sum: 15, average: 3, count: 5 }

// In workflow
const workflow = new Workflow()
  .fetch({ url: "https://api.example.com/data", response_type: "json" })
  .javaScript({
    code: `
      const data = input.json;
      return data.filter(item => item.active === true);
    `,
  })
  .debugLog({ log_level: "info" });
```

**Features:**

- Safe JavaScript execution using interpreter
- Access to input data within code
- Error handling and logging
- Suitable for data transformation and filtering

### LambdaTask

Executes custom JavaScript functions with full access to task context and configuration.

**Input Schema:**

- Accepts any input data (flexible schema)

**Output Schema:**

- Returns whatever the provided function outputs

**Configuration:**

- `execute`: Function for standard execution
- `executePreview`: Function for lightweight preview execution

**Examples:**

```typescript
// Function with execute pattern
const result = await Lambda(
  { numbers: [1, 2, 3, 4, 5] },
  {
    execute: async (input, context) => {
      const sum = input.numbers.reduce((a, b) => a + b, 0);
      await context.updateProgress(50, "Calculating sum");
      const average = sum / input.numbers.length;
      await context.updateProgress(100, "Complete");
      return { sum, average };
    },
  }
);

// Preview pattern (lightweight, fast — used by runPreview)
const previewResult = await new LambdaTask(
  { message: "Hello" },
  {
    executePreview: async (input, _context) => {
      return {
        processed: input.message.toUpperCase(),
        timestamp: new Date().toISOString(),
      };
    },
  }
).runPreview();

// Data transformation function
const transformer = await new LambdaTask(
  {
    data: [
      { name: "John", age: 30 },
      { name: "Jane", age: 25 },
    ],
  },
  {
    execute: async (input) => {
      return {
        users: input.data.map((user) => ({
          ...user,
          isAdult: user.age >= 18,
          category: user.age < 30 ? "young" : "mature",
        })),
      };
    },
  }
).run();

// Async operation with external API
const apiProcessor = await new LambdaTask(
  { userId: 123 },
  {
    execute: async (input, context) => {
      await context.updateProgress(25, "Fetching user data");
      const userData = await fetch(`/api/users/${input.userId}`).then((r) => r.json());

      await context.updateProgress(75, "Processing data");
      const enrichedData = {
        ...userData,
        processedAt: new Date().toISOString(),
        isActive: userData.lastLogin > Date.now() - 86400000, // 24 hours
      };

      await context.updateProgress(100, "Complete");
      return enrichedData;
    },
  }
).run();
```

**Features:**

- Full access to execution context and progress tracking
- Support for both committed run and live preview execution patterns
- Async/await support
- Flexible input/output schemas
- Cacheable by default

### JsonTask

Creates and executes task graphs from JSON configurations, enabling dynamic workflow creation.

**Input Schema:**

- `json` (string, required): JSON string defining tasks and their dependencies

**Output Schema:**

- `output` (any): Output depends on the generated task graph

**JSON Format:**

```typescript
interface JsonTaskItem {
  id: string; // Unique task identifier
  type: string; // Task type (e.g., "FetchUrlTask", "DelayTask")
  input?: any; // Task input data
  config?: any; // Task configuration
  dependencies?: {
    // Input dependencies from other tasks
    [inputField: string]:
      | {
          id: string; // Source task ID
          output: string; // Output field from source task
        }
      | Array<{ id: string; output: string }>;
  };
}
```

**Examples:**

```typescript
// Simple linear workflow
const linearWorkflow = await new JsonTask({
  json: JSON.stringify([
    {
      id: "fetch-data",
      type: "FetchUrlTask",
      input: {
        url: "https://api.example.com/users",
        response_type: "json",
      },
    },
    {
      id: "log-data",
      type: "DebugLogTask",
      config: { log_level: "info" },
      dependencies: {
        console: { id: "fetch-data", output: "json" },
      },
    },
    {
      id: "delay",
      type: "DelayTask",
      config: { delay: 1000 },
    },
  ]),
}).run();

// Complex workflow with data dependencies
const complexWorkflow = await new JsonTask({
  json: JSON.stringify([
    {
      id: "fetch-users",
      type: "FetchUrlTask",
      input: {
        url: "https://api.example.com/users",
        response_type: "json",
      },
    },
    {
      id: "fetch-posts",
      type: "FetchUrlTask",
      input: {
        url: "https://api.example.com/posts",
        response_type: "json",
      },
    },
    {
      id: "combine-data",
      type: "JavaScriptTask",
      input: {
        code: `
          const users = input.users;
          const posts = input.posts;
          return users.map(user => ({
            ...user,
            posts: posts.filter(post => post.userId === user.id)
          }));
        `,
      },
      dependencies: {
        input: [
          { id: "fetch-users", output: "json" },
          { id: "fetch-posts", output: "json" },
        ],
      },
    },
    {
      id: "log-result",
      type: "DebugLogTask",
      config: { log_level: "dir" },
      dependencies: {
        console: { id: "combine-data", output: "output" },
      },
    },
  ]),
}).run();

// Dynamic task creation from external config
const configResponse = await fetch("/api/workflow-config");
const workflowConfig = await configResponse.json();

const dynamicWorkflow = await new JsonTask({
  json: JSON.stringify(workflowConfig.tasks),
}).run();
```

**Features:**

- Dynamic task graph creation from JSON
- Support for complex dependency relationships
- All registered task types are available
- Automatic data flow between tasks
- Enables configuration-driven workflows

### ArrayTask

A compound task that processes arrays by either executing directly for non-array inputs or creating parallel task instances for array inputs. Supports parallel processing of array elements and combination generation when multiple inputs are arrays.

**Key Features:**

- Automatically handles single values or arrays
- Parallel execution for array inputs
- Generates all combinations when multiple inputs are arrays
- Uses `x-replicate` annotation to mark array-capable inputs

**Examples:**

```typescript
import { ArrayTask, DataPortSchema } from "@workglow/tasks";

class ArrayProcessorTask extends ArrayTask<{ items: string[] }, { results: string[] }> {
  static readonly type = "ArrayProcessorTask";

  static inputSchema() {
    return {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "string",
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  static outputSchema() {
    return {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "string",
          },
        },
      },
      required: ["results"],
      additionalProperties: false,
    } as const satisfies DataPortSchema;
  }

  async execute(input: { items: string[] }) {
    return { results: input.items.map((item) => item.toUpperCase()) };
  }
}

// Process array items in parallel
const task = new ArrayProcessorTask({
  items: ["hello", "world", "foo", "bar"],
});

const result = await task.run();
// { results: ["HELLO", "WORLD", "FOO", "BAR"] }
```

**Features:**

- Parallel processing of array elements
- Automatic task instance creation per array element
- Combination generation for multiple array inputs
- Seamless single-value and array handling

## Filesystem Tasks (server builds)

The Node and Electron builds ship three tasks that read the local filesystem —
`FileGrepTask`, `FileLoaderTask` and `FileSedTask`.

**Every host says whether it wants them.** `registerCommonTasks()` takes a
required `fileSystemTasks` flag, because the registry is what a _deserialized_
graph resolves a task type through, and a serialized node supplies its own
`config` — so a graph naming `FileGrepTask` also names its own `roots`, and no
default this package picks can constrain it. The only control that survives
untrusted graph JSON is the task not being resolvable at all. There is no
default either way: a default would hand every host the filesystem tasks, or
take them from a host whose stored workflows already name them, with nothing at
the call site to say so.

```typescript
import { registerCommonTasks } from "@workglow/tasks";

// A server that runs graph JSON it did not author:
registerCommonTasks({ fileSystemTasks: false });

// A local CLI or desktop app, where every graph reaching the registry is trusted:
registerCommonTasks({ fileSystemTasks: true });
```

`registerFileSystemTasks()` adds the three on their own, for a host that
registers its task surface in pieces.

The classes are exported either way, so constructing one directly needs no
registration:

```typescript
import { FileGrepTask } from "@workglow/tasks";

const result = await new FileGrepTask({
  roots: ["/srv/data"], // defaults to [process.cwd()]
  defaults: { url: "/srv/data/app.log", pattern: "ERROR" },
}).run();
```

### Root containment

Each task resolves and `realpath`s a local path before opening it, then
requires the result to sit inside one of `config.roots`. Omitting `roots` means
`[process.cwd()]` — **not** "anywhere on the host". The `filesystem:read`
entitlement is not a substitute: it is only consulted when the embedder both
runs the graph with `enforceEntitlements` and registers an
`ENTITLEMENT_ENFORCER`, and neither is the default.

Set `allowAnyRoot: true` to read any path the process can open. It has to be
said explicitly; leaving `roots` unset never implies it.

```typescript
new FileGrepTask({ allowAnyRoot: true, defaults: { url, pattern } });
```

An unresolvable entry in `roots` fails the call wherever it sits in the array.

## Workflow Integration

All tasks can be used standalone or integrated into workflows:

```typescript
import { Workflow } from "@workglow/tasks";

// Fluent workflow API
const workflow = new Workflow()
  .fetch({
    url: "https://api.example.com/data",
    response_type: "json",
  })
  .javaScript({
    code: "return input.json.filter(item => item.status === 'active');",
  })
  .debugLog(undefined, { log_level: "info" })
  .delay(undefined, { delay: 500 })
  .lambda(
    {},
    {
      execute: async (input) => ({
        processed: true,
        count: input.output.length,
        timestamp: new Date().toISOString(),
      }),
    }
  );

const result = await workflow.run();
```

## Error Handling

Tasks include comprehensive error handling:

```typescript
try {
  const result = await new FetchUrlTask({
    url: "https://api.example.com/data",
    response_type: "json",
    timeout: 5000,
  }).run();
} catch (error) {
  if (error instanceof TaskInvalidInputError) {
    console.error("Invalid input:", error.message);
  } else if (error instanceof RetryableJobError) {
    console.error("Retryable error:", error.message);
    // Will be retried automatically
  } else if (error instanceof PermanentJobError) {
    console.error("Permanent error:", error.message);
    // Will not be retried
  }
}
```

## Configuration

Tasks support various configuration options:

```typescript
// Task-specific configuration
const fetchTask = new FetchUrlTask(
  {
    url: "https://api.example.com/data",
    response_type: "json",
  },
  {
    queue: "api-requests",
    timeout: 10000,
    retryAttempts: 3,
  }
);

// Global workflow configuration
const workflow = new Workflow({
  maxConcurrency: 5,
  timeout: 30000,
});
```

## Testing

```bash
bun test
```

## License

Apache 2.0 - See [LICENSE](./LICENSE) for details.
