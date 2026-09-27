# @workglow/job-queue

A TypeScript-first job queue system with a separated client-server architecture for managing and processing asynchronous tasks. Features rate limiting, progress tracking, automatic retries, and cross-platform persistence.

- [Features](#features)
- [Installation](#installation)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
  - [Jobs](#jobs)
  - [JobQueueClient](#jobqueueclient)
  - [JobQueueServer](#jobqueueserver)
  - [JobQueueWorker](#jobqueueworker)
- [Usage Examples](#usage-examples)
  - [Creating Custom Jobs](#creating-custom-jobs)
  - [Submitting Jobs](#submitting-jobs)
  - [Progress Tracking](#progress-tracking)
  - [Error Handling and Retries](#error-handling-and-retries)
  - [Event Listeners](#event-listeners)
  - [Aborting Jobs](#aborting-jobs)
- [Storage Configurations](#storage-configurations)
- [Rate Limiting Strategies](#rate-limiting-strategies)
- [Scaling Workers](#scaling-workers)
- [Cross-Process Communication](#cross-process-communication)
- [API Reference](#api-reference)
- [TypeScript Types](#typescript-types)
- [Testing](#testing)
- [License](#license)

## Features

- **Separated architecture**: Client, server, and worker components for flexible deployment
- **Cross-platform**: Works in browsers (IndexedDB), Node.js, and Bun
- **Multiple storage backends**: In-Memory, IndexedDB, SQLite, PostgreSQL
- **Rate limiting**: Concurrency, delay, and composite rate limiting strategies
- **Progress tracking**: Real-time job progress with events and callbacks
- **Retry logic**: Configurable retry attempts with support for delayed retries
- **Event system**: Comprehensive event listeners for job lifecycle
- **TypeScript-first**: Full type safety with generic input/output types
- **Worker scaling**: Dynamic worker count adjustment
- **Same-process optimization**: Direct event forwarding when client and server run together
- **Cross-process support**: Storage-based subscriptions for distributed deployments

## Installation

```bash
bun add @workglow/job-queue
```

For specific storage backends, you may need additional dependencies:

```bash
# For SQLite support
bun add @workglow/sqlite

# For PostgreSQL support
bun add pg @types/pg

# For comprehensive storage options
bun add @workglow/storage
```

## Architecture

The job queue system is split into three main components:

```
┌─────────────────┐     ┌─────────────────┐
│  JobQueueClient │────▶│  JobQueueServer │
│  (submit jobs)  │     │  (coordinate)   │
└─────────────────┘     └────────┬────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │  Worker  │ │  Worker  │ │  Worker  │
              └──────────┘ └──────────┘ └──────────┘
                    │            │            │
                    └────────────┴────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │     Storage     │
                        └─────────────────┘
```

- **JobQueueClient**: Submits jobs and monitors their progress
- **JobQueueServer**: Coordinates workers, manages lifecycle, handles cleanup
- **JobQueueWorker**: Processes jobs from the queue

## Quick Start

```typescript
import {
  InMemoryQueueStorage,
  Job,
  JobQueueClient,
  JobQueueServer,
  IJobExecuteContext,
} from "@workglow/job-queue";

// 1. Define your input/output types
interface ProcessTextInput {
  text: string;
  uppercase?: boolean;
}

interface ProcessTextOutput {
  processedText: string;
  wordCount: number;
}

// 2. Create a custom job class
class ProcessTextJob extends Job<ProcessTextInput, ProcessTextOutput> {
  async execute(input: ProcessTextInput, context: IJobExecuteContext): Promise<ProcessTextOutput> {
    await context.updateProgress(25, "Starting text processing");

    const processedText = input.uppercase ? input.text.toUpperCase() : input.text.toLowerCase();
    await context.updateProgress(50, "Processing text");

    const wordCount = input.text.split(/\s+/).filter((word) => word.length > 0).length;
    await context.updateProgress(100, "Complete");

    return { processedText, wordCount };
  }
}

// 3. Set up storage, server, and client
const queueName = "text-processor";
const storage = new InMemoryQueueStorage<ProcessTextInput, ProcessTextOutput>(queueName);
await storage.setupDatabase();

const server = new JobQueueServer(ProcessTextJob, {
  storage,
  queueName,
  workerCount: 2,
  deleteAfterCompletionMs: 60_000, // Clean up after 1 minute
});

const client = new JobQueueClient<ProcessTextInput, ProcessTextOutput>({
  storage,
  queueName,
});

// 4. Connect client to server for same-process optimization
client.attach(server);

// 5. Start the server
await server.start();

// 6. Submit jobs and wait for results
const handle = await client.submit({ text: "Hello World", uppercase: true });
const result = await handle.waitFor();
console.log(result); // { processedText: "HELLO WORLD", wordCount: 2 }

// 7. Clean up
await server.stop();
```

## Core Concepts

### Jobs

Jobs are units of work with strongly typed input and output. Extend the `Job` class and implement the `execute` method:

```typescript
class MyJob extends Job<MyInput, MyOutput> {
  async execute(input: MyInput, context: IJobExecuteContext): Promise<MyOutput> {
    // Check for abort signal
    if (context.signal.aborted) {
      throw new AbortSignalJobError("Job was aborted");
    }

    // Update progress
    await context.updateProgress(50, "Halfway there", { stage: "processing" });

    // Do work and return result
    return { result: "done" };
  }
}
```

### JobQueueClient

The client submits jobs and monitors their progress. It can operate in two modes:

1. **Attached to server** (same process): Direct event forwarding for optimal performance
2. **Connected via storage** (cross process): Uses storage subscriptions for updates

```typescript
const client = new JobQueueClient<Input, Output>({
  storage,
  queueName: "my-queue",
});

// Option 1: Attach to local server (recommended for same-process)
client.attach(server);

// Option 2: Connect via storage (for cross-process scenarios)
client.connect();
```

### JobQueueServer

The server coordinates workers, manages job lifecycle, and handles cleanup:

```typescript
const server = new JobQueueServer(MyJob, {
  storage,
  queueName: "my-queue",
  workerCount: 4, // Number of concurrent workers
  pollIntervalMs: 100, // How often workers check for new jobs
  maxIdlePollIntervalMs: 1_000, // Ceiling an empty queue's polling backs off to
  deleteAfterCompletionMs: 60_000, // Delete completed jobs after 1 minute
  deleteAfterFailureMs: 300_000, // Delete failed jobs after 5 minutes
  deleteAfterDisabledMs: 60_000, // Delete disabled jobs after 1 minute
  cleanupIntervalMs: 10_000, // How often to run cleanup
  limiter: new ConcurrencyLimiter(10), // Rate limiting
});
```

While the queue is empty and a worker runs nothing, its poll interval doubles per empty poll
from `pollIntervalMs` up to `maxIdlePollIntervalMs` (default 1s). Work that announces itself —
a submit from an attached client, a storage with change notifications, a job finishing — wakes
workers at once and resets the backoff, so the ceiling only bounds how late a worker notices
unannounced work: rows another process wrote to a storage without change notifications (SQLite,
Postgres), or an expired lease. Set it equal to `pollIntervalMs` to poll at a fixed rate.

### JobQueueWorker

Workers are created and managed by the server. You typically don't interact with them directly, but they can be used standalone for custom scenarios:

```typescript
const worker = new JobQueueWorker(MyJob, {
  storage,
  queueName: "my-queue",
  limiter: new ConcurrencyLimiter(5),
  pollIntervalMs: 100,
});

await worker.start();
// Worker processes jobs until stopped
await worker.stop();
```

## Usage Examples

### Creating Custom Jobs

```typescript
import { Job, IJobExecuteContext, RetryableJobError, PermanentJobError } from "@workglow/job-queue";

interface DownloadInput {
  url: string;
  filename: string;
}

interface DownloadOutput {
  filepath: string;
  size: number;
}

class DownloadJob extends Job<DownloadInput, DownloadOutput> {
  async execute(input: DownloadInput, context: IJobExecuteContext): Promise<DownloadOutput> {
    const { url, filename } = input;

    // Handle abort signal
    const checkAbort = () => {
      if (context.signal.aborted) {
        throw new AbortSignalJobError("Download aborted");
      }
    };

    checkAbort();
    await context.updateProgress(10, "Starting download");

    // Simulate download with progress
    for (let i = 20; i <= 90; i += 10) {
      checkAbort();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await context.updateProgress(i, `Downloaded ${i}%`);
    }

    await context.updateProgress(100, "Download complete");

    return {
      filepath: `/downloads/${filename}`,
      size: 1024 * 1024,
    };
  }
}
```

### Submitting Jobs

```typescript
// Submit a single job
const handle = await client.submit(
  { url: "https://example.com/file.zip", filename: "file.zip" },
  {
    maxRetries: 5, // Override default retry count
    jobRunId: "batch-001", // Group related jobs
    runAfter: new Date(Date.now() + 60000), // Delay execution by 1 minute
    deadlineAt: new Date(Date.now() + 3600000), // Must complete within 1 hour
  }
);

// The handle provides methods to interact with the job
console.log(handle.id); // Job ID
const output = await handle.waitFor(); // Wait for completion
await handle.abort(); // Abort the job
handle.onProgress((progress, message, details) => {
  console.log(`${progress}%: ${message}`);
});

// Submit multiple jobs
const handles = await client.submitBatch(
  [
    { url: "https://example.com/file1.zip", filename: "file1.zip" },
    { url: "https://example.com/file2.zip", filename: "file2.zip" },
  ],
  { jobRunId: "batch-002" }
);
```

### Progress Tracking

```typescript
// Method 1: Using the job handle
const handle = await client.submit(input);
const cleanup = handle.onProgress((progress, message, details) => {
  console.log(`Job ${handle.id}: ${progress}% - ${message}`);
  if (details) {
    console.log("Details:", details);
  }
});

await handle.waitFor();
cleanup(); // Remove listener

// Method 2: Using client events
client.on("job_progress", (queueName, jobId, progress, message, details) => {
  console.log(`[${queueName}] Job ${jobId}: ${progress}% - ${message}`);
});

// Method 3: Using onJobProgress for a specific job
const removeListener = client.onJobProgress(jobId, (progress, message, details) => {
  console.log(`Progress: ${progress}%`);
});
```

### Error Handling and Retries

```typescript
import { RetryableJobError, PermanentJobError, AbortSignalJobError } from "@workglow/job-queue";

class ApiCallJob extends Job<{ endpoint: string }, { data: unknown }> {
  async execute(input: { endpoint: string }, context: IJobExecuteContext) {
    try {
      const response = await fetch(input.endpoint, { signal: context.signal });

      if (response.status === 429) {
        // Rate limited - retry after delay
        throw new RetryableJobError(
          "Rate limited",
          new Date(Date.now() + 60000) // Retry in 1 minute
        );
      }

      if (response.status === 404) {
        // Not found - don't retry
        throw new PermanentJobError("Endpoint not found");
      }

      if (!response.ok) {
        // Server error - allow retries (uses default retry logic)
        throw new RetryableJobError(`HTTP ${response.status}`);
      }

      return { data: await response.json() };
    } catch (error) {
      if (
        error instanceof RetryableJobError ||
        error instanceof PermanentJobError ||
        error instanceof AbortSignalJobError
      ) {
        throw error;
      }
      // Network errors - allow retries
      throw new RetryableJobError(String(error));
    }
  }
}
```

#### Custom error-code reconstruction

When a worker persists a domain-specific `error_code` (e.g. `FETCH_PRIVATE_DENIED`,
`LLM_CONTEXT_LENGTH_EXCEEDED`) and a client `waitFor()`s the job, the client
needs to rebuild a typed `JobError` (retryable vs permanent) from the persisted
code alone — the worker process may not exist anymore.

`JobQueueClient` consults the **error-code reconstructor registry** for this.
Packages register a reconstructor for their code prefix as a module side-effect:

```typescript
import { registerErrorCodeReconstructor, PermanentJobError, RetryableJobError } from "@workglow/job-queue";

function buildMyError(errorCode: string, message: string) {
  if (errorCode === "MY_RATE_LIMITED") return new RetryableJobError(message);
  const err = new PermanentJobError(message);
  err.code = errorCode;
  return err;
}

registerErrorCodeReconstructor("MY_", buildMyError);
```

Contract:

- **Prefix-matched, first-registered-wins** on conflicts (a warning is logged
  if a second registration overwrites the first).
- **Reconstructors MUST NOT throw.** Return a fallback `PermanentJobError`
  with `code` set when you receive an unknown future code sharing your prefix —
  this keeps older clients forward-compatible with newer workers. If a
  reconstructor does throw, the client logs a warning and falls through to a
  generic `JobError` with `code` set to the persisted code.
- **Built-in codes take precedence over registered reconstructors.**
  `PermanentJobError`, `RetryableJobError`, `AbortSignalJobError`, and
  `JobDisabledError` are handled by the client directly — a registered prefix
  that happens to match (e.g. `"P"` against `PermanentJobError`) will *not*
  intercept them. Do not register reconstructors for these names.
- **Reconstructors MUST set `code` to the passed `errorCode`.** The client
  defensively overrides any mismatch (and warns) so downstream branching on
  `err.code` is reliable.
- For test hygiene, prefer `snapshotErrorCodeReconstructors()` +
  `restoreErrorCodeReconstructors(snapshot)` in `beforeEach`/`afterEach` so
  registrations made by neighboring test files (via ESM import side-effects)
  are not destroyed for the rest of the worker. `clearErrorCodeReconstructors()`
  and `unregisterErrorCodeReconstructor()` remain available but permanently
  clear the table for the current worker.

### Event Listeners

```typescript
// Client events
client.on("job_start", (queueName, jobId) => {
  console.log(`Job ${jobId} started`);
});

client.on("job_complete", (queueName, jobId, output) => {
  console.log(`Job ${jobId} completed:`, output);
});

client.on("job_error", (queueName, jobId, error) => {
  console.error(`Job ${jobId} failed: ${error}`);
});

client.on("job_retry", (queueName, jobId, runAfter) => {
  console.log(`Job ${jobId} will retry at ${runAfter}`);
});

client.on("job_disabled", (queueName, jobId) => {
  console.log(`Job ${jobId} was disabled`);
});

client.on("job_aborting", (queueName, jobId) => {
  console.log(`Job ${jobId} abort requested`);
});

// Server events
server.on("server_start", (queueName) => {
  console.log(`Server ${queueName} started`);
});

server.on("server_stop", (queueName) => {
  console.log(`Server ${queueName} stopped`);
});

// Wait for specific events
const [queueName, jobId, output] = await client.waitOn("job_complete");
```

### Aborting Jobs

```typescript
// Abort a single job
const handle = await client.submit({ taskType: "long_running" });
await handle.abort();

// Or using the client directly
await client.abort(jobId);

// Abort all jobs in a job run
await client.abortJobRun("batch-001");
```

## Storage Configurations

### In-Memory Storage

```typescript
import { InMemoryQueueStorage } from "@workglow/job-queue";

const storage = new InMemoryQueueStorage<Input, Output>("my-queue");
await storage.setupDatabase();
```

### IndexedDB Storage (Browser)

```typescript
import { IndexedDbQueueStorage } from "@workglow/indexeddb/job-queue";

const storage = new IndexedDbQueueStorage<Input, Output>("my-queue");
await storage.setupDatabase();
```

### SQLite Storage (Node.js/Bun)

`SqliteQueueStorage` takes an open **`Sqlite.Database`** instance (not a path string).

```typescript
import { SqliteQueueStorage } from "@workglow/sqlite/job-queue";
import { Sqlite } from "@workglow/sqlite/storage";

await Sqlite.init();
const db = new Sqlite.Database("./jobs.db");
const storage = new SqliteQueueStorage<Input, Output>(db, "my-queue");
await storage.setupDatabase();
```

### PostgreSQL Storage (Node.js/Bun)

```typescript
import { PostgresQueueStorage } from "@workglow/postgres/job-queue";
import { Pool } from "pg";

const pool = new Pool({
  host: "localhost",
  port: 5432,
  database: "jobs",
  user: "postgres",
  password: "password",
});

const storage = new PostgresQueueStorage<Input, Output>(pool, "my-queue");
await storage.setupDatabase();
```

## Rate Limiting Strategies

### Concurrency Limiter

```typescript
import { ConcurrencyLimiter } from "@workglow/job-queue";

// Limit to 5 concurrent jobs
const limiter = new ConcurrencyLimiter(5);
```

### Delay Limiter

```typescript
import { DelayLimiter } from "@workglow/job-queue";

// Minimum 500ms delay between job starts
const limiter = new DelayLimiter(500);
```

### Rate Limiter

```typescript
import { InMemoryRateLimiterStorage, RateLimiter } from "@workglow/job-queue";

// Create storage for the rate limiter
const rateLimiterStorage = new InMemoryRateLimiterStorage();

// Max 10 executions per 60-second window
const limiter = new RateLimiter(rateLimiterStorage, "my-queue", {
  maxExecutions: 10,
  windowSizeInSeconds: 60,
  initialBackoffDelay: 1000,
  backoffMultiplier: 2,
  maxBackoffDelay: 60000,
});
```

### Composite Limiter

```typescript
import {
  CompositeLimiter,
  ConcurrencyLimiter,
  DelayLimiter,
  InMemoryRateLimiterStorage,
  RateLimiter,
} from "@workglow/job-queue";

// Create storage for the rate limiter
const rateLimiterStorage = new InMemoryRateLimiterStorage();

// Combine multiple limiting strategies
const limiter = new CompositeLimiter([
  new ConcurrencyLimiter(3),
  new DelayLimiter(100),
  new RateLimiter(rateLimiterStorage, "my-queue", {
    maxExecutions: 20,
    windowSizeInSeconds: 60,
  }),
]);
```

## Scaling Workers

```typescript
// Start with 2 workers
const server = new JobQueueServer(MyJob, {
  storage,
  queueName: "my-queue",
  workerCount: 2,
});

await server.start();

// Scale up to 5 workers
await server.scaleWorkers(5);

// Scale down to 1 worker
await server.scaleWorkers(1);

// Check current worker count
console.log(server.getWorkerCount());
```

## Cross-Process Communication

When the client and server run in different processes, use storage subscriptions:

```typescript
// Process A: Server
const server = new JobQueueServer(MyJob, { storage, queueName });
await server.start();

// Process B: Client
const client = new JobQueueClient<Input, Output>({ storage, queueName });
client.connect(); // Uses storage subscriptions instead of direct attachment

const handle = await client.submit(input);
await handle.waitFor(); // Works across processes

// Don't forget to disconnect when done
client.disconnect();
```

## API Reference

### JobQueueClient

```typescript
class JobQueueClient<Input, Output> {
  // Connection management
  attach(server: JobQueueServer<Input, Output>): void;
  detach(): void;
  connect(): void;
  disconnect(): void;

  // Job submission
  submit(input: Input, options?: SubmitOptions): Promise<JobHandle<Output>>;
  submitBatch(
    inputs: readonly Input[],
    options?: BatchOptions
  ): Promise<readonly JobHandle<Output>[]>;

  // Job queries
  getJob(id: unknown): Promise<Job<Input, Output> | undefined>;
  getJobsByRunId(runId: string): Promise<readonly Job<Input, Output>[]>;
  peek(status?: JobStatus, num?: number): Promise<readonly Job<Input, Output>[]>;
  size(status?: JobStatus): Promise<number>;
  outputForInput(input: Input): Promise<Output | null>;

  // Job control
  waitFor(jobId: unknown): Promise<Output>;
  abort(jobId: unknown): Promise<void>;
  abortJobRun(jobRunId: string): Promise<void>;

  // Progress tracking
  onJobProgress(jobId: unknown, listener: JobProgressListener): () => void;

  // Events
  on<Event extends JobQueueEvents>(event: Event, listener: Listener): void;
  off<Event extends JobQueueEvents>(event: Event, listener: Listener): void;
  once<Event extends JobQueueEvents>(event: Event, listener: Listener): void;
  waitOn<Event extends JobQueueEvents>(event: Event): Promise<Parameters>;
}
```

### JobQueueServer

```typescript
class JobQueueServer<Input, Output> {
  // Lifecycle
  start(): Promise<this>;
  stop(): Promise<this>;
  isRunning(): boolean;

  // Workers
  scaleWorkers(count: number): Promise<void>;
  getWorkerCount(): number;

  // Statistics
  getStats(): JobQueueStats;
  getStorage(): IQueueStorage<Input, Output>;

  // Events
  on<Event extends JobQueueServerEvents>(event: Event, listener: Listener): void;
  off<Event extends JobQueueServerEvents>(event: Event, listener: Listener): void;
}
```

### JobHandle

```typescript
interface JobHandle<Output> {
  readonly id: unknown;
  waitFor(): Promise<Output>;
  abort(): Promise<void>;
  onProgress(callback: JobProgressListener): () => void;
}
```

### Job Class

```typescript
class Job<Input, Output> {
  // Properties
  id: unknown;
  input: Input;
  output: Output | null;
  status: JobStatus;
  progress: number;
  progressMessage: string;
  progressDetails: Record<string, unknown> | null;
  maxRetries: number;
  runAttempts: number;
  error: string | null;
  errorCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
  runAfter: Date;
  deadlineAt: Date | null;
  lastRanAt: Date | null;
  jobRunId: string | undefined;
  fingerprint: string | undefined;

  // Methods (override in subclass)
  execute(input: Input, context: IJobExecuteContext): Promise<Output>;
}
```

## TypeScript Types

```typescript
// Job statuses
type JobStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "ABORTING" | "DISABLED";

// Job execution context
interface IJobExecuteContext {
  signal: AbortSignal;
  updateProgress: (
    progress: number,
    message?: string,
    details?: Record<string, unknown> | null
  ) => Promise<void>;
}

// Progress listener
type JobProgressListener = (
  progress: number,
  message: string,
  details: Record<string, unknown> | null
) => void;

// Queue statistics
interface JobQueueStats {
  readonly totalJobs: number;
  readonly completedJobs: number;
  readonly failedJobs: number;
  readonly abortedJobs: number;
  readonly retriedJobs: number;
  readonly disabledJobs: number;
  readonly averageProcessingTime?: number;
  readonly lastUpdateTime: Date;
}

// Client options
interface JobQueueClientOptions<Input, Output> {
  readonly storage: IQueueStorage<Input, Output>;
  readonly queueName: string;
}

// Server options
interface JobQueueServerOptions<Input, Output> {
  readonly storage: IQueueStorage<Input, Output>;
  readonly queueName: string;
  readonly limiter?: ILimiter;
  readonly workerCount?: number;
  readonly pollIntervalMs?: number;
  readonly maxIdlePollIntervalMs?: number;
  readonly deleteAfterCompletionMs?: number;
  readonly deleteAfterFailureMs?: number;
  readonly deleteAfterDisabledMs?: number;
  readonly cleanupIntervalMs?: number;
}
```

## Testing

Run tests:

```bash
bun test
```

Example test:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  InMemoryQueueStorage,
  Job,
  JobQueueClient,
  JobQueueServer,
  IJobExecuteContext,
} from "@workglow/job-queue";

class TestJob extends Job<{ data: string }, { result: string }> {
  async execute(input: { data: string }, context: IJobExecuteContext) {
    await context.updateProgress(50, "Processing");
    return { result: input.data.toUpperCase() };
  }
}

describe("JobQueue", () => {
  let server: JobQueueServer<{ data: string }, { result: string }>;
  let client: JobQueueClient<{ data: string }, { result: string }>;
  let storage: InMemoryQueueStorage<{ data: string }, { result: string }>;

  beforeEach(async () => {
    storage = new InMemoryQueueStorage("test-queue");
    await storage.setupDatabase();

    server = new JobQueueServer(TestJob, {
      storage,
      queueName: "test-queue",
      pollIntervalMs: 1,
    });

    client = new JobQueueClient({
      storage,
      queueName: "test-queue",
    });

    client.attach(server);
  });

  afterEach(async () => {
    await server.stop();
    await storage.deleteAll();
  });

  it("should process jobs successfully", async () => {
    await server.start();

    const handle = await client.submit({ data: "hello" });
    const result = await handle.waitFor();

    expect(result).toEqual({ result: "HELLO" });
  });

  it("should track progress", async () => {
    await server.start();

    const progressUpdates: number[] = [];
    const handle = await client.submit({ data: "test" });

    handle.onProgress((progress) => {
      progressUpdates.push(progress);
    });

    await handle.waitFor();

    expect(progressUpdates).toContain(50);
  });
});
```

## License

Apache 2.0 - See [LICENSE](./LICENSE) for details
