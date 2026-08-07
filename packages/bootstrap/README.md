# @workglow/bootstrap

Runtime bootstrap for Workglow: registers every built-in default onto a service registry.

Workglow does not self-register defaults at import time. Something has to install
the logger, telemetry, worker-manager, credential, model, provider, knowledge-base,
MCP, storage, task, and transform factories before any task runs — this package is
that something, sitting below both the `workglow` meta-package and the test harness
so neither has to own its own copy.

## Installation

```bash
npm install @workglow/bootstrap
# or
bun add @workglow/bootstrap
```

## Usage

### Global runtime

Call once at application startup, before running any task.

```typescript
import { bootstrapWorkglow } from "@workglow/bootstrap";

bootstrapWorkglow();
```

Pass a logger to replace the env-driven default:

```typescript
import { bootstrapWorkglow } from "@workglow/bootstrap";
import { TsLogLogger } from "workglow";

bootstrapWorkglow({ logger: new TsLogLogger() });
```

`bootstrapWorkglow()` is idempotent — defaults register with `registerIfAbsent`,
so an earlier explicit registration (a custom storage backend, say) is never
overwritten, and repeat calls are harmless.

### Isolated context

For tests, multi-tenant servers, and embedded use: a fresh registry backed by its
own container, disposable without touching global state.

```typescript
import { createOrchestrationContext } from "@workglow/bootstrap";

const ctx = createOrchestrationContext();
try {
  await task.run({ context: ctx });
} finally {
  await ctx.dispose();
}
```

### Registering onto a registry you already have

```typescript
import { registerAllDefaults } from "@workglow/bootstrap";
import { globalServiceRegistry } from "@workglow/util";

registerAllDefaults(globalServiceRegistry);
```

The registry parameter is **required**, deliberately. The function mutates
whichever container it is handed, so which one that is belongs at the call site —
a defaulted global would let a caller reach for an isolated context and silently
mutate process-wide state instead. Prefer `bootstrapWorkglow()` or
`createOrchestrationContext()`; reach for `registerAllDefaults` only when the
registry is one you constructed yourself.

## Dependency weight

This package registers **all** defaults by design — that is the whole point of a
single bootstrap seam, and splitting it into per-tier entry points would just move
the drift problem it was extracted to solve. The cost is that it depends on
`@workglow/ai`, `@workglow/knowledge-base`, and `@workglow/mcp`, and the last of
those carries a hard runtime dependency on `@modelcontextprotocol/sdk`. A consumer
that wants only, say, logger + task + storage defaults therefore installs the MCP
SDK and the full AI layer for nothing.

If that weight matters, do not depend on this package. Call the individual
`register*Defaults(registry)` functions directly from the packages you actually
use — they are all exported, and `registerAllDefaults` is nothing more than the
14 of them in dependency order:

```typescript
import { registerTabularStorageDefaults } from "@workglow/storage";
import { registerTaskDefaults } from "@workglow/task-graph";
import { registerLoggerDefaults } from "@workglow/util";

registerLoggerDefaults(registry);
registerTabularStorageDefaults(registry);
registerTaskDefaults(registry);
```

Order matters: the primitive containers (input resolvers/compactors, logger,
telemetry, worker manager) must register before anything that stores into them.
See `src/bootstrap/registerAllDefaults.ts` for the canonical ordering.

## Relationship to `workglow`

`packages/workglow/src/bootstrap.ts` is a pure re-export of this package, so
`workglow/bootstrap` and the `workglow` root barrel keep exposing the same API.
Add a new default registration **here**, not there.

## License

Apache 2.0 - See [LICENSE](./LICENSE) for details.
