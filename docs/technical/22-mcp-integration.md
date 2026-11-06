<!--
  @license
  Copyright 2025 Steven Roussey <sroussey@gmail.com>
  SPDX-License-Identifier: Apache-2.0
-->

# MCP Integration

## Overview

The `@workglow/tasks` package provides first-class integration with the Model Context Protocol (MCP), enabling Workglow pipelines to interact with external MCP servers as regular task nodes. MCP is an open protocol that allows AI applications to connect to tool servers, prompt libraries, and resource providers through a standardized interface.

Workglow's MCP integration consists of five task types (`McpToolCallTask`, `McpPromptGetTask`, `McpResourceReadTask`, `McpListTask`, `McpSearchTask`), a server registry and repository system for managing MCP server configurations, a multi-transport client factory supporting stdio, SSE, and Streamable HTTP connections, and a comprehensive authentication layer supporting six authentication methods. All MCP tasks participate in the standard Workglow task lifecycle -- they declare JSON Schema inputs and outputs, support the entitlement system, and can be wired into `TaskGraph` or `Workflow` pipelines alongside any other task.

The integration is designed to be platform-aware. Transport schemas and the stdio transport implementation are injected at runtime through the `McpTaskDeps` dependency injection mechanism, so browser builds can exclude stdio-specific code while still supporting SSE and Streamable HTTP transports.

## MCP Server Registry

### Architecture

MCP server management follows a two-tier design: an in-memory connection map for active server references, and a persistent repository backed by `ITabularStorage` for server configuration records.

The registry is built on the `ServiceRegistry` dependency injection system. Two service tokens govern the global state:

```typescript
const MCP_SERVERS = createServiceToken<Map<string, McpServerConnection>>("mcp-server.registry");
const MCP_SERVER_REPOSITORY = createServiceToken<McpServerRepository>("mcp-server.repository");
```

Both are lazily initialized in the `globalServiceRegistry` with sensible defaults: `MCP_SERVERS` starts as an empty `Map`, and `MCP_SERVER_REPOSITORY` defaults to an `InMemoryMcpServerRepository`.

### Registering a Server

```typescript
import { registerMcpServer } from "@workglow/tasks";

await registerMcpServer({
  server_id: "my-tools",
  transport: "streamable-http",
  server_url: "https://tools.example.com/mcp",
  label: "My Tools Server",
  description: "Custom tool server for data processing",
});
```

The `registerMcpServer` function adds the server to both the in-memory connection map and the persistent repository. The `server_id` field serves as the primary key.

### Retrieving Servers

```typescript
import { getMcpServer, getGlobalMcpServerRepository } from "@workglow/tasks";

// Quick lookup from the in-memory map
const connection = getMcpServer("my-tools");

// Repository-based operations
const repo = getGlobalMcpServerRepository();
const allServers = await repo.enumerateAll();
const server = await repo.getServer("my-tools");
const count = await repo.size();
```

### Repository Events

The `McpServerRepository` emits events when servers are added, removed, or updated:

```typescript
const repo = getGlobalMcpServerRepository();

repo.on("server_added", (record) => {
  console.log(`Server registered: ${record.server_id}`);
});

repo.on("server_removed", (record) => {
  console.log(`Server removed: ${record.server_id}`);
});

repo.on("server_updated", (record) => {
  console.log(`Server config updated: ${record.server_id}`);
});
```

### Input Resolution

MCP tasks accept server references in two forms: as a string ID or as an inline configuration object. The framework uses the `format: "mcp-server"` schema annotation with registered input resolvers and compactors to handle both transparently.

When a task receives a string server reference (e.g., `"my-tools"`), the resolver looks up the full `McpServerRecord` from the registry -- first checking any scoped `ServiceRegistry`, then falling back to the global registry and repository. When the task receives a full configuration object, the compactor can extract the `server_id` for serialization.

```typescript
// Both of these are valid server references in task inputs:
{ server: "my-tools" }                              // String ID (resolved at runtime)
{ server: { transport: "sse", server_url: "..." } } // Inline config
```

## Server Configuration

### Transport Types

Three transport types are supported:

| Transport         | Protocol                     | Use Case                                                         |
| ----------------- | ---------------------------- | ---------------------------------------------------------------- |
| `stdio`           | Standard I/O pipes           | Local tool servers spawned as child processes (Node.js/Bun only) |
| `sse`             | Server-Sent Events over HTTP | Remote servers using the legacy SSE transport                    |
| `streamable-http` | Streamable HTTP              | Remote servers using the current MCP HTTP transport              |

The configuration schema uses JSON Schema conditional validation (`if`/`then`) to enforce transport-specific required fields:

- **stdio**: Requires `command`; optionally accepts `args` (string array) and `env` (environment variables).
- **sse**: Requires `server_url`.
- **streamable-http**: Requires `server_url`.

### McpServerConfig Interface

The `McpServerConfig` interface defines the full set of configuration properties:

```typescript
interface McpServerConfig {
  readonly transport?: string;
  readonly server_url?: string;
  readonly command?: string; // stdio only
  readonly args?: string[]; // stdio only
  readonly env?: Record<string, string>; // stdio only
  readonly auth?: McpAuthConfig;
  readonly auth_type?: string; // flat auth from schema forms
  readonly authProvider?: OAuthClientProvider; // external provider
}
```

### McpServerRecord Schema

The `McpServerRecordSchema` extends the server config schema with metadata fields for the repository:

| Field         | Type       | Description                                    |
| ------------- | ---------- | ---------------------------------------------- |
| `server_id`   | `string`   | Primary key for the repository                 |
| `label`       | `string`   | Human-readable display label                   |
| `description` | `string`   | Optional description                           |
| `transport`   | `string`   | One of `"stdio"`, `"sse"`, `"streamable-http"` |
| `server_url`  | `string`   | URL for SSE/Streamable HTTP transports         |
| `command`     | `string`   | Command to run for stdio transport             |
| `args`        | `string[]` | Command arguments for stdio transport          |
| `env`         | `object`   | Environment variables for stdio transport      |

## Authentication

### Supported Auth Types

The MCP integration supports six authentication methods, defined as a discriminated union on the `type` field:

| Auth Type                | Description                                           | Required Fields                         |
| ------------------------ | ----------------------------------------------------- | --------------------------------------- |
| `none`                   | No authentication                                     | --                                      |
| `bearer`                 | Static bearer token                                   | `token`                                 |
| `client_credentials`     | OAuth 2.0 Client Credentials Grant                    | `client_id`, `client_secret`            |
| `private_key_jwt`        | OAuth 2.0 with JWT client assertion (dynamic signing) | `client_id`, `private_key`, `algorithm` |
| `static_private_key_jwt` | OAuth 2.0 with pre-built JWT assertion                | `client_id`, `jwt_bearer_assertion`     |
| `authorization_code`     | OAuth 2.0 Authorization Code Grant                    | `client_id`, `redirect_url`             |

### CredentialStoreOAuthProvider

For OAuth flows that require token persistence, the `CredentialStoreOAuthProvider` implements the MCP SDK's `OAuthClientProvider` interface backed by `ICredentialStore`. It stores tokens, client information, PKCE code verifiers, and OAuth discovery state under namespaced keys derived from the server URL:

```
mcp:oauth:{normalized_server_url}:tokens
mcp:oauth:{normalized_server_url}:client_info
mcp:oauth:{normalized_server_url}:code_verifier
mcp:oauth:{normalized_server_url}:discovery
```

This enables token persistence across short-lived MCP connections that share the same server URL.

### Credential Resolution

Secret values in auth configurations can reference the global `ICredentialStore` by key. The `resolveAuthSecrets` function resolves these references before establishing a connection:

```typescript
// Auth config may contain credential store keys:
{ type: "bearer", token: "my-api-key-store-key" }

// resolveAuthSecrets looks up the key in the credential store
// and replaces it with the actual secret value
const resolved = await resolveAuthSecrets(authConfig, credentialStore);
```

When an explicit credential store is passed, resolution is **strict by default** and a missing key throws `MissingCredentialError` — this prevents the literal key name from silently flowing through as a bearer token. The legacy literal-passthrough behaviour is preserved for the no-argument form (which falls back to the global store) and can be re-enabled per call via the `{ strict: false }` option.

### Auth Provider Factory

The `createAuthProvider` factory function constructs the appropriate `OAuthClientProvider` for each auth type:

- **none / bearer**: Returns `undefined` (bearer tokens are handled via HTTP headers at the transport level).
- **client_credentials**: Uses `CredentialStoreOAuthProvider` with client credentials grant, or falls back to the SDK's `ClientCredentialsProvider` when no credential store is available.
- **private_key_jwt**: Uses `CredentialStoreOAuthProvider` with JWT client authentication via `createPrivateKeyJwtAuth`, or falls back to `PrivateKeyJwtProvider`.
- **static_private_key_jwt**: Uses `CredentialStoreOAuthProvider` with a static JWT assertion, or falls back to `StaticPrivateKeyJwtProvider`.
- **authorization_code**: Requires a credential store for token persistence; throws if none is available.

## MCP Tasks

All MCP tasks extend the base `Task` class from `@workglow/task-graph` and follow standard task conventions: static `type`, `category`, `inputSchema()`, `outputSchema()`, and `configSchema()` declarations, plus an `execute()` method.

### McpToolCallTask

Calls a tool on an MCP server and returns the result.

**Static Properties:**

- `type`: `"McpToolCallTask"`
- `category`: `"MCP"`
- `cachePolicy`: `{ kind: "none" }`
- `customizable`: `true`
- `hasDynamicSchemas`: `true`

**Config Schema:**

| Field       | Type                        | Description                                                |
| ----------- | --------------------------- | ---------------------------------------------------------- |
| `server`    | `string \| McpServerConfig` | MCP server reference (ID or inline config)                 |
| `tool_name` | `string`                    | Name of the tool to call (format: `"string:mcp-toolname"`) |

**Dynamic Schema Discovery:** When the task has a server and tool name configured but no explicit input/output schemas, `discoverSchemas()` connects to the server, lists available tools, and adopts the matching tool's `inputSchema` and `outputSchema` into `config`. This allows the UI to display appropriate input fields for any MCP tool without hardcoding schemas. `config.outputSchema` is the tool's own schema; the task's `outputSchema()` nests it under `structured` (`mcpToolOutputPortSchema`), so a UI drawing ports should read the task's schema, not the config field.

**Execution:** Connects to the MCP server, calls the named tool with the task input as arguments, and returns the result. The output includes `content` (array of text, image, audio, resource, or resource_link items) and `isError`. The tool's own result goes on `structured`: its `structuredContent` when the response carries one, otherwise a single text item holding a JSON object, parsed. It is kept apart so a tool field can never shadow `content` or `isError`, and so a tool adding a field does not move the ports a graph is wired to. Wiring reads a tool field as `structured.<field>`.

**Workflow Integration:**

```typescript
const workflow = new Workflow();
workflow.mcpToolCall({
  server: "my-tools",
  tool_name: "calculate",
});
```

### McpPromptGetTask

Gets a prompt from an MCP server.

**Static Properties:**

- `type`: `"McpPromptGetTask"`
- `category`: `"MCP"`
- `cachePolicy`: `{ kind: "none" }`
- `customizable`: `true`
- `hasDynamicSchemas`: `true`

**Config Schema:**

| Field         | Type                        | Description                                                   |
| ------------- | --------------------------- | ------------------------------------------------------------- |
| `server`      | `string \| McpServerConfig` | MCP server reference                                          |
| `prompt_name` | `string`                    | Name of the prompt to get (format: `"string:mcp-promptname"`) |

**Dynamic Schema Discovery:** Connects to the server's prompt list and builds an input schema from the prompt's declared arguments. Each argument becomes a string property; required arguments are marked as required in the schema.

**Output:** Returns `messages` (array of role/content pairs with `"user"` or `"assistant"` roles) and an optional `description`.

**Workflow Integration:**

```typescript
const workflow = new Workflow();
workflow.mcpPromptGet({
  server: "my-prompts",
  prompt_name: "code-review",
});
```

### McpResourceReadTask

Reads a resource from an MCP server.

**Static Properties:**

- `type`: `"McpResourceReadTask"`
- `category`: `"MCP"`
- `cachePolicy`: `{ kind: "none" }`
- `customizable`: `true`

**Config Schema:**

| Field          | Type                        | Description                                                          |
| -------------- | --------------------------- | -------------------------------------------------------------------- |
| `server`       | `string \| McpServerConfig` | MCP server reference                                                 |
| `resource_uri` | `string`                    | URI of the resource to read (format: `"string:uri:mcp-resourceuri"`) |

**Output:** Returns `contents`, an array of resource items. Each item has a `uri` and either `text` (for text resources) or `blob` (for binary resources), plus an optional `mimeType`.

**Workflow Integration:**

```typescript
const workflow = new Workflow();
workflow.mcpResourceRead({
  server: "my-server",
  resource_uri: "file:///path/to/document.md",
});
```

### McpListTask

Lists tools, resources, or prompts available on an MCP server.

**Static Properties:**

- `type`: `"McpListTask"`
- `category`: `"MCP"`
- `cachePolicy`: `{ kind: "none" }`
- `hasDynamicSchemas`: `true`

**Input Schema:**

| Field       | Type                                  | Description          |
| ----------- | ------------------------------------- | -------------------- |
| `server`    | `string \| McpServerConfig`           | MCP server reference |
| `list_type` | `"tools" \| "resources" \| "prompts"` | What to list         |

**Dynamic Output Schema:** The output schema changes based on `list_type`. When set to `"tools"`, only the `tools` array is in the output schema. When set to `"resources"`, only the `resources` array. When set to `"prompts"`, only the `prompts` array. When `list_type` is not yet determined, the output schema includes all three. The task emits a schema change event whenever `list_type` changes via `setInput()`.

**Workflow Integration:**

```typescript
const workflow = new Workflow();
workflow.mcpList({ server: "my-server", list_type: "tools" });
```

### McpSearchTask

Searches the public MCP server registry at `https://registry.modelcontextprotocol.io` for servers matching a query.

**Static Properties:**

- `type`: `"McpSearchTask"`
- `category`: `"MCP"`
- `cachePolicy`: `{ kind: "none" }`

**Input Schema:**

| Field   | Type     | Description                       |
| ------- | -------- | --------------------------------- |
| `query` | `string` | Search query for the MCP registry |

**Output:** Returns `results`, an array of search result items. Each item includes an `id`, `label`, `description`, and a `config` object that can be used to configure a connection to the discovered server.

The `mapMcpRegistryResult` function converts registry server entries into usable configurations. It handles npm packages (via `npx`), PyPI packages (via `uvx`), OCI containers (via `docker run`), and remote HTTP servers.

**Workflow Integration:**

```typescript
const workflow = new Workflow();
workflow.mcpSearch({ query: "weather" });
```

## McpElicitationConnector

The `McpElicitationConnector` class bridges the Workglow `IHumanConnector` interface with MCP's `Server.elicitInput()` capability. It enables tasks that require human input to delegate to an MCP client for structured form collection.

The connector handles three interaction kinds:

- **`notify`**: Sends a fire-and-forget notification via `server.sendLoggingMessage()`.
- **`display`**: Sends content for display via logging, resolves immediately.
- **`elicit`**: Delegates to `server.elicitInput()` with a form-mode schema, returning the user's structured response.

```typescript
import { Server } from "@modelcontextprotocol/sdk/server";
import { McpElicitationConnector, HUMAN_CONNECTOR } from "@workglow/tasks";

const mcpServer: Server = /* your MCP server instance */;
const connector = new McpElicitationConnector(mcpServer);
registry.registerInstance(HUMAN_CONNECTOR, connector);
```

## Entitlements

MCP tasks declare entitlements to enable permission-based execution control. Each task declares static entitlements and can augment them at the instance level based on the configured transport:

| Entitlement                      | Value                 | Used By                                    |
| -------------------------------- | --------------------- | ------------------------------------------ |
| `Entitlements.MCP`               | `"mcp"`               | `McpListTask`                              |
| `Entitlements.MCP_TOOL_CALL`     | `"mcp:tool-call"`     | `McpToolCallTask`                          |
| `Entitlements.MCP_PROMPT_GET`    | `"mcp:prompt-get"`    | `McpPromptGetTask`                         |
| `Entitlements.MCP_RESOURCE_READ` | `"mcp:resource-read"` | `McpResourceReadTask`                      |
| `Entitlements.MCP_STDIO`         | `"mcp:stdio"`         | Any MCP task using stdio transport         |
| `Entitlements.NETWORK`           | `"network"`           | All server-connecting MCP tasks (optional) |
| `Entitlements.NETWORK_HTTP`      | `"network:http"`      | `McpSearchTask`                            |
| `Entitlements.CREDENTIAL`        | `"credential"`        | Tasks requiring authentication (optional)  |

Instance-level entitlements are computed dynamically: when a task's server config uses the `stdio` transport, the `MCP_STDIO` entitlement is added via `mergeEntitlements()`, signaling that the task will spawn a local process.

## Platform Dependency Injection

The `McpTaskDeps` interface defines the platform-specific dependencies that must be registered before MCP tasks can be used:

```typescript
interface McpTaskDeps {
  readonly mcpClientFactory: {
    readonly create: (
      config: McpServerConfig,
      signal?: AbortSignal
    ) => Promise<{ client: Client; transport: Transport }>;
  };
  readonly mcpServerConfigSchema: {
    readonly properties: DataPortSchemaObject["properties"];
    readonly allOf: NonNullable<DataPortSchemaObject["allOf"]>;
  };
  readonly createStdioTransport: (config: McpServerConfig) => Promise<Transport>;
}
```

Platform entry files (`browser.ts`, `node.ts`) register appropriate implementations via `registerMcpTaskDeps()`. The browser build omits the stdio transport factory, while the Node build — which also serves Bun — provides an implementation that spawns child processes.

Attempting to use MCP tasks without registering dependencies throws a descriptive error directing the developer to import from a platform entry file.

## API Reference

### Registry Functions

| Function                       | Signature                                          | Description                                                 |
| ------------------------------ | -------------------------------------------------- | ----------------------------------------------------------- |
| `registerMcpServer`            | `(config: McpServerRecord) => Promise<void>`       | Register a server in both the in-memory map and repository. |
| `getMcpServer`                 | `(id: string) => McpServerConnection \| undefined` | Look up a server connection by ID.                          |
| `getGlobalMcpServers`          | `() => Map<string, McpServerConnection>`           | Get the global server connection map.                       |
| `getGlobalMcpServerRepository` | `() => McpServerRepository`                        | Get the global server repository.                           |
| `setGlobalMcpServerRepository` | `(repo: McpServerRepository) => void`              | Replace the global server repository.                       |

### McpServerRepository

| Method                           | Signature                                                      | Description                                                    |
| -------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| `addServer`                      | `(record: McpServerRecord) => Promise<McpServerRecord>`        | Add or update a server record.                                 |
| `removeServer`                   | `(server_id: string) => Promise<void>`                         | Remove a server by ID.                                         |
| `getServer`                      | `(server_id: string) => Promise<McpServerRecord \| undefined>` | Look up a server record.                                       |
| `enumerateAll`                   | `() => Promise<McpServerRecord[]>`                             | List all server records.                                       |
| `size`                           | `() => Promise<number>`                                        | Count of stored servers.                                       |
| `on` / `off` / `once` / `waitOn` | Event subscription methods                                     | Listen for `server_added`, `server_removed`, `server_updated`. |

### Client Utilities

| Function             | Signature                                                                                                | Description                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `createMcpClient`    | `(config: McpServerConfig, signal?: AbortSignal) => Promise<{ client: Client; transport: Transport }>`   | Create and connect an MCP client.                                   |
| `buildAuthConfig`    | `(flat: Record<string, unknown>) => McpAuthConfig \| undefined`                                          | Build typed auth config from flat schema properties.                |
| `createAuthProvider` | `(auth: McpAuthConfig, serverUrl: string, store?: ICredentialStore) => OAuthClientProvider \| undefined` | Create an OAuth provider for the given auth config.                 |
| `resolveAuthSecrets` | `(auth: McpAuthConfig, store?: ICredentialStore) => Promise<McpAuthConfig>`                              | Resolve credential store keys to secret values.                     |
| `getMcpServerConfig` | `(configOrInput: Record<string, unknown>) => McpServerConfig`                                            | Extract and validate server config from a task config/input object. |

### Task Classes

| Class                 | Type String             | Category | Inputs                          | Outputs                                |
| --------------------- | ----------------------- | -------- | ------------------------------- | -------------------------------------- |
| `McpToolCallTask`     | `"McpToolCallTask"`     | MCP      | Dynamic (from tool schema)      | `{ content, isError, structured }`  |
| `McpPromptGetTask`    | `"McpPromptGetTask"`    | MCP      | Dynamic (from prompt arguments) | `{ messages, description? }`           |
| `McpResourceReadTask` | `"McpResourceReadTask"` | MCP      | (none)                          | `{ contents }`                         |
| `McpListTask`         | `"McpListTask"`         | MCP      | `{ server, list_type }`         | `{ tools? \| resources? \| prompts? }` |
| `McpSearchTask`       | `"McpSearchTask"`       | MCP      | `{ query }`                     | `{ results }`                          |

### Standalone Execution Functions

Each task class also exports a standalone function for use outside pipelines:

| Function                | Signature                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `mcpToolCall`           | `(input: Record<string, unknown>, config: McpToolCallTaskConfig) => Promise<McpToolCallTaskOutput>`   |
| `mcpPromptGet`          | `(input: Record<string, unknown>, config: McpPromptGetTaskConfig) => Promise<McpPromptGetTaskOutput>` |
| `mcpResourceRead`       | `(config: McpResourceReadTaskConfig) => Promise<McpResourceReadTaskOutput>`                           |
| `mcpList`               | `(input: McpListTaskInput, config?: TaskConfig) => Promise<McpListTaskOutput>`                        |
| `mcpSearch`             | `(input: McpSearchTaskInput, config?: TaskConfig) => Promise<McpSearchTaskOutput>`                    |
| `searchMcpRegistry`     | `(query: string, signal?: AbortSignal) => Promise<McpSearchResultItem[]>`                             |
| `searchMcpRegistryPage` | `(query: string, options?: { cursor?; signal? }) => Promise<McpRegistrySearchPage>`                   |
