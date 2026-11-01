# @workglow/storage

Modular storage solutions for Workglow.AI platform with multiple backend implementations. Provides consistent interfaces for key-value, tabular, and vector data storage. Job queue persistence lives in `@workglow/job-queue` and the vendor `./job-queue` packages.

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Core Concepts](#core-concepts)
  - [Type Safety](#type-safety)
  - [Environment Compatibility](#environment-compatibility)
  - [Import Patterns](#import-patterns)
- [Storage Types](#storage-types)
  - [Key-Value Storage](#key-value-storage)
    - [Basic Usage](#basic-usage)
    - [Environment-Specific Examples](#environment-specific-examples)
    - [Bulk Operations](#bulk-operations)
    - [Event Handling](#event-handling)
  - [Tabular Storage](#tabular-storage)
    - [Schema Definition](#schema-definition)
    - [CRUD Operations](#crud-operations)
    - [Bulk Operations](#bulk-operations-1)
    - [Searching and Filtering](#searching-and-filtering)
    - [Environment-Specific Tabular Storage](#environment-specific-tabular-storage)
- [Environment-Specific Usage](#environment-specific-usage)
  - [Browser Environment](#browser-environment)
  - [Node.js Environment](#nodejs-environment)
  - [Bun Environment](#bun-environment)
- [Advanced Features](#advanced-features)
  - [Repository Registry](#repository-registry)
  - [Event-Driven Architecture](#event-driven-architecture)
  - [Compound Primary Keys](#compound-primary-keys)
  - [Custom File Layout (KV on filesystem)](#custom-file-layout-kv-on-filesystem)
- [API Reference](#api-reference)
  - [IKvStorage\<Key, Value\>](#ikvrepositorykey-value)
  - [ITabularStorage\<Schema, PrimaryKeyNames\>](#itabularrepositoryschema-primarykeynames)
- [Examples](#examples)
  - [User Management System](#user-management-system)
  - [Configuration Management](#configuration-management)
- [Testing](#testing)
  - [Writing Tests for Your Storage Usage](#writing-tests-for-your-storage-usage)
- [License](#license)

## Quick Start

```typescript
// Key-Value Storage (simple data)
import { InMemoryKvStorage } from "@workglow/storage";

const kvStore = new InMemoryKvStorage<string, { name: string; age: number }>();
await kvStore.put("user:123", { name: "Alice", age: 30 });
const kvUser = await kvStore.get("user:123"); // { name: "Alice", age: 30 }
```

```typescript
// Tabular Storage (structured data with schemas)
import { InMemoryTabularStorage } from "@workglow/storage";
import { JsonSchema } from "@workglow/util";

const userSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    email: { type: "string" },
    age: { type: "number" },
  },
  required: ["id", "name", "email", "age"],
  additionalProperties: false,
} as const satisfies JsonSchema;

const userRepo = new InMemoryTabularStorage<typeof userSchema, ["id"]>(
  userSchema,
  ["id"], // primary key
  ["email"] // additional indexes
);

await userRepo.put({ id: "123", name: "Alice", email: "alice@example.com", age: 30 });
const user = await userRepo.get({ id: "123" });
```

## Installation

```bash
# Using bun (recommended)
bun install @workglow/storage

# Using npm
npm install @workglow/storage

# Using yarn
yarn add @workglow/storage
```

## Core Concepts

### Type Safety

All storage implementations are fully typed using TypeScript and JSON Schema for runtime validation:

```typescript
import { JsonSchema, FromSchema } from "@workglow/util";

// Define your data structure
const ProductSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    price: { type: "number" },
    category: { type: "string" },
    inStock: { type: "boolean" },
  },
  required: ["id", "name", "price", "category", "inStock"],
  additionalProperties: false,
} as const satisfies JsonSchema;

// TypeScript automatically infers:
// Entity = FromSchema<typeof ProductSchema>
// PrimaryKey = { id: string }
```

### Environment Compatibility

| Storage Type | Node.js | Bun | Browser | Persistence |
| ------------ | ------- | --- | ------- | ----------- |
| InMemory     | ✅      | ✅  | ✅      | ❌          |
| IndexedDB    | ❌      | ❌  | ✅      | ✅          |
| SQLite       | ✅      | ✅  | ❌      | ✅          |
| PostgreSQL   | ✅      | ✅  | ❌      | ✅          |
| DuckDB       | ✅      | ✅  | ❌      | ✅          |
| Supabase     | ✅      | ✅  | ✅      | ✅          |
| FileSystem   | ✅      | ✅  | ❌      | ✅          |

### Import Patterns

The package uses conditional exports, so importing from `@workglow/storage` automatically selects the right build for your runtime (browser, Node.js, or Bun).

```typescript
// Import from the top-level package; it resolves to the correct target per environment
import { InMemoryKvStorage, SqliteTabularStorage } from "@workglow/storage";
```

### SQLite setup (`@workglow/storage/sqlite`)

Before you open SQLite with a **file path** or construct **`new Sqlite.Database(...)`**, call **`await Sqlite.init()`** once per runtime (Node.js, Bun, or browser). Export is available from **`workglow`** and **`@workglow/storage/sqlite`**. The call is idempotent. On the browser it loads the SQLite WASM build; on Node.js and Bun it loads the built-in `node:sqlite` (Node 24+ / Bun 1.4+).

## Storage Types

### Key-Value Storage

Simple key-value storage for unstructured or semi-structured data.

#### Basic Usage

```typescript
import { InMemoryKvStorage, FsFolderJsonKvRepository } from "@workglow/storage";

// In-memory (for testing/caching)
const cache = new InMemoryKvStorage<string, any>();
await cache.put("config", { theme: "dark", language: "en" });

// File-based JSON (persistent)
const settings = new FsFolderJsonKvRepository("./data/settings");
await settings.put("user:preferences", { notifications: true });
```

#### Environment-Specific Examples

```typescript
// Browser (using IndexedDB)
import { IndexedDbKvRepository } from "@workglow/storage";
const browserStore = new IndexedDbKvRepository("my-app-storage");

// Node.js/Bun (using SQLite)
import { SqliteKvRepository } from "@workglow/storage";
import { Sqlite } from "@workglow/storage/sqlite";

await Sqlite.init();
// Pass a file path or a Sqlite.Database instance (see @workglow/storage/sqlite)
const sqliteStore = new SqliteKvRepository("./data.db", "config_table");

// PostgreSQL (Node.js/Bun)
import { PostgresKvRepository } from "@workglow/storage";
import type { Pool } from "@workglow/storage/postgres";
const pool = new Pool({ connectionString: "postgresql://..." });
const pgStore = new PostgresKvRepository(pool, "settings");

// Supabase (Node.js/Bun)
import { SupabaseKvRepository } from "@workglow/storage";
import { createClient } from "@supabase/supabase-js";
const supabase = createClient("https://your-project.supabase.co", "your-anon-key");
const supabaseStore = new SupabaseKvRepository(supabase, "settings");
```

#### Bulk Operations

```typescript
const store = new InMemoryKvStorage<string, { name: string; score: number }>();

// Bulk insert
await store.putBulk([
  { key: "player1", value: { name: "Alice", score: 100 } },
  { key: "player2", value: { name: "Bob", score: 85 } },
]);

// Get all data
const allPlayers = await store.getAll();
// Result: [{ key: "player1", value: { name: "Alice", score: 100 } }, ...]

// Get size
const count = await store.size(); // 2
```

#### Event Handling

```typescript
const store = new InMemoryKvStorage<string, any>();

// Listen to storage events
store.on("put", (key, value) => {
  console.log(`Stored: ${key} = ${JSON.stringify(value)}`);
});

store.on("get", (key, value) => {
  console.log(`Retrieved: ${key} = ${value ? "found" : "not found"}`);
});

await store.put("test", { data: "example" }); // Triggers 'put' event
await store.get("test"); // Triggers 'get' event
```

### Tabular Storage

Structured storage with schemas, primary keys, and indexing for complex data relationships.

#### Schema Definition

```typescript
import { JsonSchema } from "@workglow/util";
import { InMemoryTabularStorage } from "@workglow/storage";

// Define your entity schema
const UserSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    name: { type: "string" },
    age: { type: "number" },
    department: { type: "string" },
    createdAt: { type: "string" },
  },
  required: ["id", "email", "name", "age", "department", "createdAt"],
  additionalProperties: false,
} as const satisfies JsonSchema;

// Create repository with primary key and indexes
const userRepo = new InMemoryTabularStorage<typeof UserSchema, ["id"]>(
  UserSchema,
  ["id"], // Primary key (can be compound: ["dept", "id"])
  ["email", "department", ["department", "age"]] // Indexes for fast lookups
);
```

#### Nullable columns and generated DDL

A nullable column can be written two ways, and both are recognized:

```typescript
{
  input: {
    anyOf: [{ type: "integer" }, { type: "null" }];
  }
} // anyOf form
{
  input: {
    type: ["integer", "null"];
  }
} // type-array form
```

As of this release the **type-array form maps to the underlying type's column
type** (`INTEGER`, `VARCHAR(n)`, …) instead of falling through to
`TEXT /* unknown type */`. Only the DDL generated for _new_ tables changes —
`CREATE TABLE IF NOT EXISTS` never alters an existing one, so a Postgres
database created before this keeps its `TEXT` columns and reads those values
back as `string` where a freshly created database returns `number`.

No migration ships for this: the declarative migration op set has no
column-type-change op, migrations are supplied per storage instance by whoever
constructs it, and no table in this repository is built from an affected schema.
Bringing an existing deployment in line is an operator action:

```sql
ALTER TABLE run_usage
  ALTER COLUMN input  TYPE INTEGER USING input::integer,
  ALTER COLUMN output TYPE INTEGER USING output::integer;
-- string columns additionally take a width; truncation policy is the operator's call
ALTER TABLE run_usage
  ALTER COLUMN "modelId" TYPE VARCHAR(255) USING left("modelId", 255);
```

The `USING left(...)` clause **truncates** any value already wider than the new
width. That is a choice about your data, not a recommendation — inspect the
column first and decide whether to widen the schema, clean the rows, or accept
the truncation.

#### Auto-Generated Primary Keys

TabularStorage supports automatic ID generation by marking schema properties with `x-auto-generated: true`:

```typescript
const UserSchema = {
  type: "object",
  properties: {
    id: { type: "integer", "x-auto-generated": true }, // Auto-increment
    name: { type: "string" },
    email: { type: "string" },
  },
  required: ["id", "name", "email"],
} as const;

const storage = new PostgresTabularStorage(db, "users", UserSchema, ["id"] as const);

// Insert without providing ID - database generates it
const user = await storage.put({ name: "Alice", email: "alice@example.com" });
console.log(user.id); // 1 (auto-generated)
```

**Generation Strategy** (inferred from type):

- `type: "integer"` → Auto-increment (SERIAL, INTEGER PRIMARY KEY, counter)
- `type: "string"` → UUID via `uuid4()` from `@workglow/util`

**Configuration Options:**

```typescript
new PostgresTabularStorage(
  db,
  "users",
  UserSchema,
  ["id"],
  [],
  { clientProvidedKeys: "if-missing" } // "never" | "if-missing" | "always"
);
```

- `"if-missing"` (default): Use client value if provided, generate otherwise
- `"never"`: Always generate (most secure)
- `"always"`: Require client value (for testing)

See [Tabular Storage README](./src/tabular/README.md) for detailed documentation.

#### CRUD Operations

```typescript
// Create
await userRepo.put({
  id: "user_123",
  email: "alice@company.com",
  name: "Alice Johnson",
  age: 28,
  department: "Engineering",
  createdAt: new Date().toISOString(),
});

// Read by primary key
const user = await userRepo.get({ id: "user_123" });

// Update (put with same primary key)
await userRepo.put({
  ...user!,
  age: 29, // Birthday!
});

// Delete
await userRepo.delete({ id: "user_123" });
```

#### Bulk Operations

```typescript
// Bulk insert
await userRepo.putBulk([
  {
    id: "1",
    email: "alice@co.com",
    name: "Alice",
    age: 28,
    department: "Engineering",
    createdAt: "2024-01-01",
  },
  {
    id: "2",
    email: "bob@co.com",
    name: "Bob",
    age: 32,
    department: "Sales",
    createdAt: "2024-01-02",
  },
  {
    id: "3",
    email: "carol@co.com",
    name: "Carol",
    age: 26,
    department: "Engineering",
    createdAt: "2024-01-03",
  },
]);

// Get all records
const allUsers = await userRepo.getAll();

// Get repository size
const userCount = await userRepo.size();
```

#### Searching and Filtering

```typescript
// Search by partial match (uses indexes when available)
const engineeringUsers = await userRepo.search({ department: "Engineering" });
const adultUsers = await userRepo.search({ age: 25 }); // Exact match

// Delete by search criteria (supports multiple columns)
await userRepo.deleteSearch({ department: "Sales" }); // Equality
await userRepo.deleteSearch({ age: { value: 65, operator: ">=" } }); // Delete users 65 and older

// Multiple criteria (AND logic)
await userRepo.deleteSearch({
  department: "Sales",
  age: { value: 30, operator: "<" },
}); // Delete young Sales employees
```

#### Environment-Specific Tabular Storage

```typescript
// SQLite (Node.js/Bun)
import { SqliteTabularStorage } from "@workglow/storage";
import { Sqlite } from "@workglow/storage/sqlite";

await Sqlite.init();
const sqliteUsers = new SqliteTabularStorage<typeof UserSchema, ["id"]>(
  "./users.db",
  "users",
  UserSchema,
  ["id"],
  ["email"]
);

// PostgreSQL (Node.js/Bun)
import { PostgresTabularStorage } from "@workglow/storage";
import type { Pool } from "@workglow/storage/postgres";

const pool = new Pool({ connectionString: "postgresql://..." });
const pgUsers = new PostgresTabularStorage<typeof UserSchema, ["id"]>(
  pool,
  "users",
  UserSchema,
  ["id"],
  ["email"]
);

// Supabase (Node.js/Bun)
import { SupabaseTabularStorage } from "@workglow/storage";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient("https://your-project.supabase.co", "your-anon-key");
const supabaseUsers = new SupabaseTabularStorage<typeof UserSchema, ["id"]>(
  supabase,
  "users",
  UserSchema,
  ["id"],
  ["email"]
);

// IndexedDB (Browser)
import { IndexedDbTabularStorage } from "@workglow/storage";
const browserUsers = new IndexedDbTabularStorage<typeof UserSchema, ["id"]>(
  "users",
  UserSchema,
  ["id"],
  ["email"]
);

// File-based (Node.js/Bun)
import { FsFolderTabularStorage } from "@workglow/storage";
const fileUsers = new FsFolderTabularStorage<typeof UserSchema, ["id"]>(
  "./data/users",
  UserSchema,
  ["id"],
  ["email"]
);
```

### Queue Storage

Persistent job queue storage for background processing and task management lives in
`@workglow/job-queue`. In-memory queue storage is exported from `@workglow/job-queue`;
backend-specific queue storage is exported from vendor packages such as
`@workglow/sqlite/job-queue`, `@workglow/postgres/job-queue`, `@workglow/indexeddb/job-queue`,
and `@workglow/supabase/job-queue`.

#### Basic Job Queue Operations

```typescript
import { InMemoryQueueStorage, JobStatus } from "@workglow/job-queue";

// Define job input/output types
type ProcessingInput = { text: string; options: any };
type ProcessingOutput = { result: string; metadata: any };

const jobQueue = new InMemoryQueueStorage<ProcessingInput, ProcessingOutput>();

// Add job to queue
const jobId = await jobQueue.add({
  input: { text: "Hello world", options: { uppercase: true } },
  run_after: null, // Run immediately
  max_retries: 3,
});

// Get next job for processing
const job = await jobQueue.next();
if (job) {
  // Process the job...
  const result = { result: "HELLO WORLD", metadata: { processed: true } };

  // Mark as complete
  await jobQueue.complete({
    ...job,
    output: result,
    status: JobStatus.COMPLETED,
  });
}
```

#### Job Management

```typescript
// Check queue status
const pendingCount = await jobQueue.size(JobStatus.PENDING);
const processingCount = await jobQueue.size(JobStatus.PROCESSING);

// Peek at jobs without removing them
const nextJobs = await jobQueue.peek(JobStatus.PENDING, 5);

// Progress tracking
await jobQueue.saveProgress(jobId, 50, "Processing...", { step: 1 });

// Handle job failures
await jobQueue.abort(jobId);

// Cleanup old completed jobs
await jobQueue.deleteJobsByStatusAndAge(JobStatus.COMPLETED, 24 * 60 * 60 * 1000); // 24 hours
```

## Environment-Specific Usage

### Browser Environment

```typescript
import {
  IndexedDbKvRepository,
  IndexedDbTabularStorage,
  SupabaseKvRepository,
  SupabaseTabularStorage,
} from "@workglow/storage";
import { IndexedDbQueueStorage } from "@workglow/indexeddb/job-queue";
import { SupabaseQueueStorage } from "@workglow/supabase/job-queue";
import { createClient } from "@supabase/supabase-js";

// Local browser storage with IndexedDB
const settings = new IndexedDbKvRepository("app-settings");
const userData = new IndexedDbTabularStorage("users", UserSchema, ["id"]);
const jobQueue = new IndexedDbQueueStorage<any, any>("background-jobs");

// Or use Supabase for cloud storage from the browser
const supabase = createClient("https://your-project.supabase.co", "your-anon-key");
const cloudSettings = new SupabaseKvRepository(supabase, "app-settings");
const cloudUserData = new SupabaseTabularStorage(supabase, "users", UserSchema, ["id"]);
const cloudJobQueue = new SupabaseQueueStorage(supabase, "background-jobs");
```

### Node.js Environment

```typescript
import {
  SqliteKvRepository,
  PostgresTabularStorage,
  FsFolderJsonKvRepository,
} from "@workglow/storage";

// Mix and match storage backends
const cache = new FsFolderJsonKvRepository("./cache");
const users = new PostgresTabularStorage(pool, "users", UserSchema, ["id"]);
```

### Bun Environment

```typescript
// Bun has access to all implementations
import {
  SqliteTabularStorage,
  FsFolderJsonKvRepository,
  SupabaseTabularStorage,
} from "@workglow/storage";
import { PostgresQueueStorage } from "@workglow/postgres/job-queue";
import { Sqlite } from "@workglow/sqlite/storage";
import { createClient } from "@supabase/supabase-js";

await Sqlite.init();
const db = new Sqlite.Database("./app.db");
const data = new SqliteTabularStorage(db, "items", ItemSchema, ["id"]);

// Or use Supabase for cloud storage
const supabase = createClient("https://your-project.supabase.co", "your-anon-key");
const cloudData = new SupabaseTabularStorage(supabase, "items", ItemSchema, ["id"]);
```

## Advanced Features

### Repository Registry

Repositories can be registered globally by ID, allowing tasks to reference them by name rather than passing direct instances. This is useful for configuring repositories once at application startup and referencing them throughout your task graphs.

#### Registering Repositories

```typescript
import {
  registerTabularStorage,
  getTabularStorage,
  InMemoryTabularStorage,
} from "@workglow/storage";

// Define your schema
const userSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    email: { type: "string" },
  },
  required: ["id", "name", "email"],
  additionalProperties: false,
} as const;

// Create and register a repository
const userRepo = new InMemoryTabularStorage(userSchema, ["id"] as const);
registerTabularStorage("users", userRepo);

// Later, retrieve the repository by ID
const repo = getTabularStorage("users");
```

#### Using Repositories in Tasks

When using repositories with tasks, you can pass either the repository ID or a direct instance. The TaskRunner automatically resolves string IDs using the registry.

```typescript
import { TypeTabularStorage } from "@workglow/storage";

// In your task's input schema, use TypeTabularStorage
static inputSchema() {
  return {
    type: "object",
    properties: {
      dataSource: TypeTabularStorage({
        title: "User Repository",
        description: "Repository containing user records",
      }),
    },
    required: ["dataSource"],
  };
}

// Both approaches work:
await task.run({ dataSource: "users" });           // Resolved from registry
await task.run({ dataSource: userRepoInstance }); // Direct instance
```

#### Schema Helper Functions

The package provides schema helper functions for defining repository inputs with proper format annotations:

```typescript
import { TypeTabularStorage } from "@workglow/storage";

// Tabular repository (format: "storage:tabular")
const tabularSchema = TypeTabularStorage({
  title: "Data Source",
  description: "Tabular data repository",
});
```

### Event-Driven Architecture

All storage implementations support event emission for monitoring and reactive programming:

```typescript
const store = new InMemoryTabularStorage(UserSchema, ["id"]);

// Monitor all operations
store.on("put", (entity) => console.log("User created/updated:", entity));
store.on("delete", (key) => console.log("User deleted:", key));
store.on("get", (key, entity) => console.log("User accessed:", entity ? "found" : "not found"));

// Wait for specific events
const [entity] = await store.waitOn("put"); // Waits for next put operation
```

### Compound Primary Keys

```typescript
import { JsonSchema } from "@workglow/util";

const OrderLineSchema = {
  type: "object",
  properties: {
    orderId: { type: "string" },
    lineNumber: { type: "number" },
    productId: { type: "string" },
    quantity: { type: "number" },
    price: { type: "number" },
  },
  required: ["orderId", "lineNumber", "productId", "quantity", "price"],
  additionalProperties: false,
} as const satisfies JsonSchema;

const orderLines = new InMemoryTabularStorage<typeof OrderLineSchema, ["orderId", "lineNumber"]>(
  OrderLineSchema,
  ["orderId", "lineNumber"], // Compound primary key
  ["productId"] // Additional index
);

// Use compound keys
await orderLines.put({
  orderId: "ORD-123",
  lineNumber: 1,
  productId: "PROD-A",
  quantity: 2,
  price: 19.99,
});
const line = await orderLines.get({ orderId: "ORD-123", lineNumber: 1 });
```

### Custom File Layout (KV on filesystem)

```typescript
import { FsFolderKvRepository } from "@workglow/storage";
import { JsonSchema } from "@workglow/util";

// Control how keys map to file paths and value encoding via schemas
const keySchema = { type: "string" } as const satisfies JsonSchema;
const valueSchema = { type: "string" } as const satisfies JsonSchema;

const files = new FsFolderKvRepository<string, string>(
  "./data/files",
  (key) => `${key}.txt`,
  keySchema,
  valueSchema
);

await files.put("note-1", "Hello world");
```

## API Reference

### IKvStorage<Key, Value>

Core interface for key-value storage:

```typescript
interface IKvStorage<Key, Value> {
  // Core operations
  put(key: Key, value: Value): Promise<void>;
  putBulk(items: Array<{ key: Key; value: Value }>): Promise<void>;
  get(key: Key): Promise<Value | undefined>;
  delete(key: Key): Promise<void>;
  getAll(): Promise<Array<{ key: Key; value: Value }> | undefined>;
  deleteAll(): Promise<void>;
  size(): Promise<number>;

  // Event handling
  on(event: "put" | "get" | "getAll" | "delete" | "deleteall", callback: Function): void;
  off(event: string, callback: Function): void;
  once(event: string, callback: Function): void;
  waitOn(event: string): Promise<any[]>;
  emit(event: string, ...args: any[]): void;
}
```

### ITabularStorage<Schema, PrimaryKeyNames>

Core interface for tabular storage:

```typescript
interface ITabularStorage<Schema, PrimaryKeyNames, Entity, PrimaryKey, Value> {
  // Core operations
  put(entity: Entity): Promise<void>;
  putBulk(entities: Entity[]): Promise<void>;
  get(key: PrimaryKey): Promise<Entity | undefined>;
  delete(key: PrimaryKey | Entity): Promise<void>;
  getAll(): Promise<Entity[] | undefined>;
  deleteAll(): Promise<void>;
  size(): Promise<number>;

  // Search operations
  search(criteria: Partial<Entity>): Promise<Entity[] | undefined>;
  deleteSearch(criteria: DeleteSearchCriteria<Entity>): Promise<void>;

  // Event handling
  on(event: "put" | "get" | "search" | "delete" | "clearall", callback: Function): void;
  off(event: string, callback: Function): void;
  once(event: string, callback: Function): void;
  waitOn(event: string): Promise<any[]>;
  emit(event: string, ...args: any[]): void;
}
```

#### DeleteSearchCriteria<Entity>

The `deleteSearch` method accepts a criteria object that supports multiple columns with optional comparison operators:

```typescript
// Type definitions
type SearchOperator = "=" | "!=" | "<" | "<=" | ">" | ">=";

interface SearchCondition<T> {
  readonly value: T;
  readonly operator: SearchOperator;
}

// The set operators take a list, so they are separate shapes rather than a
// widened `SearchCondition["value"]`.
interface SearchInCondition<T> {
  readonly value: readonly T[];
  readonly operator: "in";
}

interface SearchNotInCondition<T> {
  readonly value: readonly T[];
  readonly operator: "not-in";
}

// A pattern match takes a string pattern, whatever the column's type.
interface SearchLikeCondition {
  readonly value: string;
  readonly operator: "like";
}

type DeleteSearchCriteria<Entity> = {
  readonly [K in keyof Entity]?:
    | Entity[K]
    | SearchCondition<Entity[K]>
    | SearchInCondition<Entity[K]>
    | SearchNotInCondition<Entity[K]>
    | SearchLikeCondition; // string columns only
};

// Usage examples
// Equality match (direct value)
await repo.deleteSearch({ category: "electronics" });

// With comparison operator
await repo.deleteSearch({ createdAt: { value: date, operator: "<" } });

// Multiple criteria (AND logic)
await repo.deleteSearch({
  category: "electronics",
  value: { value: 100, operator: ">=" },
});
```

##### Set membership (`in`)

The same criteria shape is accepted by `query`, `queryPage`, `queryIndex`,
`count`, `updateWhere`, and `deleteSearch`. The `in` operator turns "rows for
these N ids" into one round trip instead of N:

```typescript
// One statement, not one query per id
const rows = await repo.query({ observation_id: { value: [1, 2, 3], operator: "in" } });

// ANDs with the other columns as usual
await repo.deleteSearch({ tenant: "acme", status: { value: ["draft", "void"], operator: "in" } });
```

An **empty list matches nothing** (`IN ()` is a syntax error in SQL, so backends
emit an always-false predicate or skip the round trip entirely).

A **null or absent column never matches**, and listing `null` does not change
that — SQL reads `NULL IN (…)` and `x IN (NULL)` alike as UNKNOWN. Ask for null
rows with `{ operator: "=", value: null }`, which the predicate builder rewrites
to `IS NULL`.

##### `undefined` is not `null`, and matches nothing

⚠️ A criterion of `undefined` — what a spread optional filter leaves behind,
`{ ...maybe }` where `maybe` is `{ col: undefined }` — is **not** read as "no
filter". It gets no `IS NULL` rewrite, since a key present with no value cannot
be told apart from one the caller meant to omit; it binds as NULL, and
`col = NULL` is never true. So the query returns **zero rows**, on every
backend, silently:

```typescript
// Returns nothing — not "every user", and not "users with no tenant".
await repo.query({ tenant: maybeTenant });   // where maybeTenant === undefined

// Omit the key when you mean no filter:
await repo.query(tenant === undefined ? { active: true } : { active: true, tenant });

// Pass null when you mean IS NULL:
await repo.query({ tenant: null });
```

Backends that hand criteria to something else decide this locally rather than
sending it, because the meaning does not survive the trip: `JSON.stringify`
drops an `undefined`-valued key entirely, and a PostgREST filter would carry
the literal text `undefined`.

**Backend limits.** Postgres binds the whole list as a single array parameter
(`= ANY($1)`), so list length is unbounded. SQLite and DuckDB expand one
placeholder per value and remain subject to their statement parameter cap
(`SQLITE_MAX_VARIABLE_NUMBER` — 999 before SQLite 3.32, 32766 after); split a
list longer than that yourself. `HuggingFaceTabularStorage` throws
`StorageUnsupportedError` because its `/filter` endpoint has no IN form, and
`FsFolderTabularStorage` does not implement `query` at all.

##### Set exclusion (`not-in`)

The complement of `in`, accepted everywhere `in` is:

```typescript
// Everything except these ids, in one round trip
const rows = await repo.query({ observation_id: { value: [1, 2, 3], operator: "not-in" } });

// ANDs with the other columns as usual
await repo.deleteSearch({ tenant: "acme", status: { value: ["published"], operator: "not-in" } });
```

Three cases follow SQL's three-valued logic rather than JavaScript's `!includes`,
so the same criterion returns the same rows on Postgres and on the in-memory
backend:

- **A null (or absent) column never matches a non-empty list.** `NULL NOT IN (1, 2)`
  is UNKNOWN, so SQL drops the row — the same rule `!=` follows. Add a separate
  `{ operator: "=", value: null }` pass if you want those rows too.
- **A `null` anywhere in the list matches nothing at all**, since
  `col NOT IN (1, NULL)` is UNKNOWN for every row `1` has not already excluded.
- **An empty list matches everything** — the exact inverse of the empty `in`
  list. That is the right answer for `query` and `count`; on `deleteSearch` it
  would empty the table, so criteria that reduce to nothing but empty
  exclusions are refused with a `StorageUnfilteredDeleteError`. A mix still
  runs: `{ tenant: "acme", excluded: { operator: "not-in", value: [] } }`
  deletes acme's rows. Use `deleteAll()` to clear a table on purpose.

**Backend limits** are the `in` list's, with the same spellings negated:
`<> ALL($1)` on Postgres (one array parameter), `NOT IN (…)` with expanded
placeholders on SQLite and DuckDB, `not.in.(…)` on Supabase — where neither
degenerate case is left to PostgREST to decide: an empty list goes out as an
always-true `.or()` group instead of an exclusion filter, and a list holding
`null` is answered as "no rows" with no request at all.
`HuggingFaceTabularStorage` throws `StorageUnsupportedError`.

##### Pattern match (`like`)

SQL `LIKE`, with the same meaning on every backend: **case-sensitive**,
anchored at both ends, `%` for any run of characters (newlines included), `_`
for exactly one character, and `\` as the escape character. Accepted everywhere
`in` is. Build "contains X" with `escapeLikePattern`, which backslash-escapes
`\`, `%` and `_` so the text matches literally:

```typescript
import { escapeLikePattern } from "@workglow/storage";

// Rows whose `items` text contains "5.02"
await repo.query({ items: { value: `%${escapeLikePattern("5.02")}%`, operator: "like" } });

// Prefix, and a literal percent sign
await repo.query({ code: { value: "ABC%", operator: "like" } });
await repo.query({ label: { value: "%50\\%%", operator: "like" } }); // contains "50%"
```

A **null or absent column never matches**, not even `%`. The value must be a
string, and a pattern ending in a lone `\` is refused (PostgreSQL rejects it);
both raise `StorageValidationError` — on `query`, `count`, `deleteSearch` and
`updateWhere` alike. **It needs a text column.** A string-typed schema column is
not always stored as text: on Postgres a `format: "date-time"` column is a
timestamp and a `format: "uuid"` one a `uuid`, and `LIKE` on either is a
database error. SQL backends report that error; the in-memory backends match
only string values.

**Backend spellings.** Postgres and DuckDB render `col LIKE $n ESCAPE '\'`
with nothing wrapped around the column, so a `pg_trgm` GIN index can serve
`%x%` (and a prefix) whatever the plan. A `text_pattern_ops` btree helps a
prefix pattern only under a custom plan: the pattern is a bound parameter, so a
generic prepared plan cannot know it is a prefix. SQLite's own `LIKE` ignores ASCII
case (and `PRAGMA case_sensitive_like` is connection-wide), so it renders a
translated, always case-sensitive `GLOB`. Supabase sends PostgREST `like`,
except for a pattern holding a literal `*` — PostgREST rewrites every `*` in a
`like` value to `%` — which goes as an equivalent anchored regex through
`match`. In-memory and IndexedDB use a two-pointer wildcard matcher, never
a `RegExp`, so a hostile pattern costs at most O(text × pattern).
`HuggingFaceTabularStorage` throws `StorageUnsupportedError`.

## Examples

### User Management System

```typescript
import { JsonSchema, FromSchema } from "@workglow/util";
import { InMemoryTabularStorage, InMemoryKvStorage } from "@workglow/storage";

// User profile with tabular storage
const UserSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    username: { type: "string" },
    email: { type: "string" },
    firstName: { type: "string" },
    lastName: { type: "string" },
    role: {
      type: "string",
      enum: ["admin", "user", "guest"],
    },
    createdAt: { type: "string" },
    lastLoginAt: { type: "string" },
  },
  required: ["id", "username", "email", "firstName", "lastName", "role", "createdAt"],
  additionalProperties: false,
} as const satisfies JsonSchema;

const userRepo = new InMemoryTabularStorage<typeof UserSchema, ["id"]>(
  UserSchema,
  ["id"],
  ["email", "username"]
);

// User sessions with KV storage
const sessionStore = new InMemoryKvStorage<string, { userId: string; expiresAt: string }>();

// User management class
class UserManager {
  constructor(
    private userRepo: typeof userRepo,
    private sessionStore: typeof sessionStore
  ) {}

  async createUser(userData: Omit<FromSchema<typeof UserSchema>, "id" | "createdAt">) {
    const user = {
      ...userData,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await this.userRepo.put(user);
    return user;
  }

  async loginUser(email: string): Promise<string> {
    const users = await this.userRepo.search({ email });
    if (!users?.length) throw new Error("User not found");

    const sessionId = crypto.randomUUID();
    await this.sessionStore.put(sessionId, {
      userId: users[0].id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    // Update last login
    await this.userRepo.put({
      ...users[0],
      lastLoginAt: new Date().toISOString(),
    });

    return sessionId;
  }

  async getSessionUser(sessionId: string) {
    const session = await this.sessionStore.get(sessionId);
    if (!session || new Date(session.expiresAt) < new Date()) {
      return null;
    }
    return this.userRepo.get({ id: session.userId });
  }
}
```

### Configuration Management

```typescript
// Application settings with typed configuration
type AppConfig = {
  database: {
    host: string;
    port: number;
    name: string;
  };
  features: {
    enableNewUI: boolean;
    maxUploadSize: number;
  };
  integrations: {
    stripe: { apiKey: string; webhook: string };
    sendgrid: { apiKey: string };
  };
};

const configStore = new FsFolderJsonKvRepository<string, AppConfig>("./config");

class ConfigManager {
  private cache = new Map<string, AppConfig>();

  constructor(private store: typeof configStore) {
    // Listen for config changes
    store.on("put", (key, value) => {
      this.cache.set(key, value);
      console.log(`Configuration updated: ${key}`);
    });
  }

  async getConfig(environment: string): Promise<AppConfig> {
    if (this.cache.has(environment)) {
      return this.cache.get(environment)!;
    }

    const config = await this.store.get(environment);
    if (!config) throw new Error(`No configuration for environment: ${environment}`);

    this.cache.set(environment, config);
    return config;
  }

  async updateConfig(environment: string, updates: Partial<AppConfig>) {
    const current = await this.getConfig(environment);
    const updated = { ...current, ...updates };
    await this.store.put(environment, updated);
  }
}
```

### Supabase Integration Example

```typescript
import { createClient } from "@supabase/supabase-js";
import { JsonSchema } from "@workglow/util";
import { SupabaseTabularStorage, SupabaseKvRepository } from "@workglow/storage";
import { SupabaseQueueStorage } from "@workglow/supabase/job-queue";

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

// Define schemas
const ProductSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    price: { type: "number" },
    category: { type: "string" },
    stock: { type: "number", minimum: 0 },
    createdAt: { type: "string", format: "date-time" },
  },
  required: ["id", "name", "price", "category", "stock", "createdAt"],
  additionalProperties: false,
} as const satisfies JsonSchema;

const OrderSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    customerId: { type: "string" },
    productId: { type: "string" },
    quantity: { type: "number", minimum: 1 },
    status: {
      type: "string",
      enum: ["pending", "processing", "completed", "cancelled"],
    },
    createdAt: { type: "string", format: "date-time" },
  },
  required: ["id", "customerId", "productId", "quantity", "status", "createdAt"],
  additionalProperties: false,
} as const satisfies JsonSchema;

// Create repositories
const products = new SupabaseTabularStorage<typeof ProductSchema, ["id"]>(
  supabase,
  "products",
  ProductSchema,
  ["id"],
  ["category", "name"] // Indexed columns for fast searching
);

const orders = new SupabaseTabularStorage<typeof OrderSchema, ["id"]>(
  supabase,
  "orders",
  OrderSchema,
  ["id"],
  ["customerId", "status", ["customerId", "status"]] // Compound index
);

// Use KV for caching
const cache = new SupabaseKvRepository(supabase, "cache");

// Use queue for background processing
type EmailJob = { to: string; subject: string; body: string };
const emailQueue = new SupabaseQueueStorage<EmailJob, void>(supabase, "emails");

// Example usage
async function createOrder(customerId: string, productId: string, quantity: number) {
  // Check product availability
  const product = await products.get({ id: productId });
  if (!product || product.stock < quantity) {
    throw new Error("Insufficient stock");
  }

  // Create order
  const order = {
    id: crypto.randomUUID(),
    customerId,
    productId,
    quantity,
    status: "pending" as const,
    createdAt: new Date().toISOString(),
  };
  await orders.put(order);

  // Update stock
  await products.put({
    ...product,
    stock: product.stock - quantity,
  });

  // Queue email notification
  await emailQueue.add({
    input: {
      to: customerId,
      subject: "Order Confirmation",
      body: `Your order ${order.id} has been confirmed!`,
    },
    run_after: null,
    max_retries: 3,
  });

  return order;
}

// Get customer's orders
async function getCustomerOrders(customerId: string) {
  return await orders.search({ customerId });
}

// Get orders by status
async function getOrdersByStatus(status: string) {
  return await orders.search({ status });
}
```

**Important Note**
The implementations assume you have an exec_sql RPC function in your Supabase database for table creation, or that you've created the tables through Supabase migrations. For production use, it's recommended to:

- Create tables using Supabase migrations rather than runtime table creation
- Set up proper Row Level Security (RLS) policies in Supabase
- Use service role keys for server-side operations that need elevated permissions

## Testing

The package includes comprehensive test suites for all storage implementations:

```bash
# Run all tests
bun test

# Run specific test suites
bun test --grep "KvRepository"
bun test --grep "TabularStorage"
bun test --grep "QueueStorage"

# Test specific environments
bun test --grep "InMemory"    # Cross-platform tests
bun test --grep "IndexedDb"   # Browser tests
bun test --grep "Sqlite"      # Native tests
```

### Writing Tests for Your Storage Usage

```typescript
import { describe, test, expect, beforeEach } from "vitest";
import { InMemoryTabularStorage } from "@workglow/storage";

describe("UserRepository", () => {
  let userRepo: InMemoryTabularStorage<typeof UserSchema, ["id"]>;

  beforeEach(() => {
    userRepo = new InMemoryTabularStorage<typeof UserSchema, ["id"]>(UserSchema, ["id"], ["email"]);
  });

  test("should create and retrieve user", async () => {
    const user = {
      id: "test-123",
      email: "test@example.com",
      name: "Test User",
      age: 25,
      department: "Engineering",
      createdAt: new Date().toISOString(),
    };

    await userRepo.put(user);
    const retrieved = await userRepo.get({ id: "test-123" });

    expect(retrieved).toEqual(user);
  });

  test("should find users by department", async () => {
    const users = [
      {
        id: "1",
        email: "alice@co.com",
        name: "Alice",
        age: 28,
        department: "Engineering",
        createdAt: "2024-01-01",
      },
      {
        id: "2",
        email: "bob@co.com",
        name: "Bob",
        age: 32,
        department: "Sales",
        createdAt: "2024-01-02",
      },
    ];

    await userRepo.putBulk(users);
    const engineers = await userRepo.search({ department: "Engineering" });

    expect(engineers).toHaveLength(1);
    expect(engineers![0].name).toBe("Alice");
  });
});
```

## License

Apache 2.0 - See [LICENSE](./LICENSE) for details
