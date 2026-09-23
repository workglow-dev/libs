# @workglow/bootstrap

Runtime bootstrap for Workglow: registers every built-in default onto a service registry.

Each registrar self-registers on the **global** registry when its module happens to
be imported — `registerModelDefaults()`, `registerTabularStorageDefaults()` and the
twelve others run at module scope, and default their `registry` parameter to the
global one. What is populated therefore depends on which modules your import graph
has pulled in, which is import-order dependent and easy to mis-diagnose.
`bootstrapWorkglow()` is the guarantee: it installs the full set — logger,
telemetry, worker-manager, credential, model, provider, knowledge-base, MCP,
storage, task, and transform factories — in dependency order, idempotently. An
isolated registry gets **nothing** until `registerAllDefaults(registry)` (or
`createOrchestrationContext()`) is called explicitly.

This package is that seam, sitting below both the `workglow` meta-package and the
test harness so neither has to own its own copy.

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

`bootstrapWorkglow()` is idempotent — repeat calls are harmless.

**Two halves, two behaviors, and the difference decides where your own
registrations go.**

The **factory tokens** (logger, telemetry, worker manager, credential store,
model repository, AI provider registry, knowledge-base and MCP maps, tabular
repositories, task constructors, transform defs) register with
`registry.registerIfAbsent`. An earlier explicit registration — a custom storage
backend, say — survives, so those may be installed **before**
`bootstrapWorkglow()`.

The **input resolvers and compactors** do not. `registerInputResolver` /
`registerInputCompactor` are an unconditional `resolvers.set(formatPrefix, fn)`:
last writer wins. Seven of the fourteen registrars install a resolver, covering
the `credential`, `image`, `knowledge-base`, `mcp-server`, `model`,
`storage:tabular` and `tasks` prefixes; six of those install a compactor too.
`image` is the exception — it hydrates a data URI it cannot compact back to an
id. A custom resolver installed **before** `bootstrapWorkglow()` is silently
replaced by the built-in one, with no warning and nothing in the registry to
inspect:

```typescript
// WRONG — bootstrapWorkglow() overwrites this during startup, and every
// `format: "model"` input then resolves from the built-in MODEL_REPOSITORY.
registerInputResolver("model", myCatalogResolver);
bootstrapWorkglow();

// RIGHT — install custom resolvers AFTER the defaults are in place.
bootstrapWorkglow();
registerInputResolver("model", myCatalogResolver);
```

The same ordering applies to `registerAllDefaults(registry)` and
`createOrchestrationContext()`.

### Isolated context

For tests, multi-tenant servers, and embedded use: a fresh registry backed by its
own container, disposable without touching global state.

```typescript
import { createOrchestrationContext } from "@workglow/bootstrap";

const ctx = createOrchestrationContext();
try {
  await task.run({}, { registry: ctx.registry });
} finally {
  await ctx.dispose();
}
```

The registry travels in the **run config** — `run()`'s second argument. The first
argument is input overrides, so passing a context there silently becomes an input
named `context`, the run uses the global registry, and `ctx.dispose()` tears down a
registry nothing ever touched.

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
