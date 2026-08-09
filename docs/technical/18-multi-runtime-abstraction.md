<!--
  @license
  Copyright 2025 Steven Roussey <sroussey@gmail.com>
  SPDX-License-Identifier: Apache-2.0
-->

# Multi-Runtime Platform Abstraction

## Overview

Workglow is designed to run identically across three JavaScript runtimes: **browsers**,
**Node.js**, and **Bun** — served by two builds, since Bun implements the Node APIs the
packages here rely on. Rather than relying on runtime detection at import time or bundling
platform polyfills into a single artifact, the framework uses a **compile-time entry point pattern**
combined with Node.js **conditional exports** to deliver the correct platform-specific code to each
runtime. The result is zero unnecessary polyfill code in any target environment, smaller bundle
sizes, and the ability to leverage native APIs (Web Workers, `worker_threads`, `CompressionStream`,
`zlib`, `OffscreenCanvas`, `sharp`, etc.) without degrading the experience on other platforms.

The abstraction is anchored in `@workglow/util`, the foundation package of the monorepo, and the
pattern it establishes is replicated by every other package in the dependency graph. This document
explains the architecture in detail: entry point conventions, conditional export configuration,
the shared common module, platform-specific modules for media/compress/workers, the build pipeline,
and how to extend the system with new platform-specific code.

Source files referenced in this document:

| File                           | Purpose                                           |
| ------------------------------ | ------------------------------------------------- |
| `packages/util/src/common.ts`  | Shared exports used by all three runtimes         |
| `packages/util/src/browser.ts` | Browser entry point                               |
| `packages/util/src/node.ts`    | Node.js entry point (also serves Bun)             |
| `packages/util/package.json`   | Conditional exports and build scripts             |
| `packages/util/tsconfig.json`  | TypeScript configuration listing all entry points |

---

## Entry Point Pattern

Every package in the Workglow monorepo follows a two-file entry point convention:

```
src/
  browser.ts    # Browser entry point
  node.ts       # Node.js entry point (also serves Bun)
  common.ts     # Shared logic re-exported by the entry points
```

Bun supports every Node.js API the packages here rely on, so a `bun.ts` that is a byte-for-byte
copy of `node.ts` buys nothing but a third build target and a third `.d.ts` to keep in sync. With
no `"bun"` condition in `exports`, Bun falls through to the `"import"`/`"types"` default and gets
the Node entry — the same code the duplicated file would have given it. **No entry in the
monorepo earns a Bun build.** The last two were `@workglow/util`'s `"."` and `"./worker"`, for a
`Worker.bun.ts` byte-identical to `Worker.browser.ts`; see [Workers](#workers) for why one Node
file now covers both.

A `src/bun.ts` is still the escape hatch if a genuine divergence ever appears — it needs the
file, a `--target=bun` build, and a `"bun"` condition ahead of the `"import"` default.

Each platform entry point re-exports everything from `common.ts` and then layers on
platform-specific modules. For `@workglow/util`, the entry points look like this:

**`browser.ts`:**

```typescript
export * from "./common";
export * from "./worker/Worker.browser";
```

**`node.ts`** (also what Bun resolves):

```typescript
export * from "./common";
export * from "./worker/Worker.node";
```

This pattern guarantees that the common API surface is identical across all three runtimes — the
only difference is how platform-specific concerns (workers, image processing, compression, etc.)
are implemented. Consumers import from the package name (`@workglow/util`) and the runtime
automatically receives the correct entry point thanks to conditional exports.

---

## Conditional Exports

The `"exports"` field in `package.json` is the mechanism that maps the `"."` import specifier to
the correct built artifact for each runtime. The resolution order within a condition block matters:
bundlers and runtimes match the **first** condition they support.

### Main export (`"."`)

```json
{
  ".": {
    "react-native": {
      "types": "./dist/browser.d.ts",
      "import": "./dist/browser.js"
    },
    "browser": {
      "types": "./dist/browser.d.ts",
      "import": "./dist/browser.js"
    },
    "types": "./dist/node.d.ts",
    "import": "./dist/node.js"
  }
}
```

Resolution rules:

1. **React Native** and **browser** bundlers (Vite, webpack, esbuild with `browser` condition)
   resolve to `dist/browser.js`.
2. Everything else — **Node.js**, **Bun**, and any other fallback — resolves to `dist/node.js`.
   Bun matches no earlier condition because there is none to match.

Each condition block includes a `"types"` field so that TypeScript resolves the correct `.d.ts`
file for the platform. This is critical because the type declarations differ per platform — for
example, the browser entry exports `Worker` as `globalThis.Worker` while the Node entry exports
a `WorkerPolyfill` that wraps `worker_threads`. That resolution is not automatic for `tsc`:
`"browser"` is not one of TypeScript's built-in conditions, so a browser consumer must set
`"customConditions": ["browser"]` in its tsconfig or it type-checks the browser bundle against
the node declarations. See [Conditional Exports](./19-build-system.md#conditional-exports).

### Sub-path exports

`@workglow/util` exposes additional sub-paths beyond `"."`, each with their own platform
conditions where appropriate:

| Sub-path                  | Description                                          | Platform-specific? |
| ------------------------- | ---------------------------------------------------- | ------------------ |
| `@workglow/util`          | Core utilities, DI, events, logging, crypto, workers | Yes (worker impl)  |
| `@workglow/util/schema`   | JSON Schema types, validation, vector/tensor math    | No                 |
| `@workglow/util/graph`    | Graph data structures (Graph, DirectedGraph, DAG)    | No                 |
| `@workglow/util/media`    | Platform-specific image handling                     | Yes                |
| `@workglow/util/compress` | Platform-specific compression                        | Yes                |
| `@workglow/util/worker`   | Lightweight worker entry point                       | Yes                |

Sub-paths that are **not** platform-specific (schema, graph) are built once with
`--target=browser` and served to all runtimes — no conditional branching needed.

Sub-paths that **are** platform-specific use the same condition structure as the main export:

```json
{
  "./media": {
    "react-native": {
      "types": "./dist/media-browser.d.ts",
      "import": "./dist/media-browser.js"
    },
    "browser": {
      "types": "./dist/media-browser.d.ts",
      "import": "./dist/media-browser.js"
    },
    "types": "./dist/media-node.d.ts",
    "import": "./dist/media-node.js"
  }
}
```

Note the absence of a `"bun"` condition: Bun shares the Node.js media implementation
(`media-node.js`) because both runtimes have access to the same server-side image APIs, and the
default `"import"` already points there. This is not the common case, it is every case — Bun and
Node share an implementation while the browser diverges, so only the browser needs a condition of
its own. `./worker` was the last holdout, and is no longer one.

---

## Common Module

`common.ts` is the shared core that both entry points re-export. It contains everything that
does not depend on platform-specific APIs:

```typescript
export * from "./crypto/Crypto";
export * from "./di";
export * from "./events/EventEmitter";
export * from "./logging";
export * from "./utilities/BaseError";
export * from "./utilities/Misc";
export * from "./utilities/objectOfArraysAsArrayOfObjects";
export * from "./utilities/TypeUtilities";
export * from "./worker/WorkerManager";
export * from "./credentials";
export * from "./crypto/WebCrypto";
export * from "./telemetry";
```

This includes the dependency injection system (`ServiceRegistry`, `globalServiceRegistry`,
`createServiceToken`), the `EventEmitter`, logging infrastructure, cryptographic utilities (using
the Web Crypto API which is available on all modern runtimes), credential management, telemetry,
the `WorkerManager` class, and general-purpose utility types and functions.

The `WorkerManager` itself lives in common because its API is platform-agnostic — it accepts
`Worker` instances and communicates via `postMessage`/`addEventListener`. The platform-specific
part is **which Worker class** is used, and that is resolved by the platform entry point.

---

## Platform-Specific Modules

### Workers

The worker abstraction is the most prominent example of platform divergence — and the sharpest
illustration of why the split is browser-vs-rest rather than three-way. Each side needs a
different `Worker` class and a corresponding `WorkerServer` that listens for messages on the
worker side.

**Browser (`Worker.browser.ts`):**

Uses the standard `globalThis.Worker` and `self` as the parent port. The `WorkerServer` listens
via `self.addEventListener("message", ...)`.

```typescript
const Worker = globalThis.Worker;
const parentPort = self;
export { Worker, parentPort };

export class WorkerServer extends WorkerServerBase {
  constructor(options?: WorkerServerBaseOptions) {
    super({ ...options, post: (message, transfer) => self.postMessage(message, transfer) });
    parentPort?.addEventListener("message", async (event) => {
      await this.handleMessage({ type: event.type, data: event.data });
    });
  }
}
```

**Node.js and Bun (`Worker.node.ts`):**

Wraps `worker_threads.Worker` in a `WorkerPolyfill` that normalizes the API to match the browser
`Worker` interface. Both gaps it closes are silent when left open, so neither is cosmetic:
`worker_threads` rejects a **stringified** `file://` URL with `ERR_WORKER_PATH` (call sites pass
`new URL(..., import.meta.url)`, so a URL is passed through and only a path is converted), and
Node's `Worker` is an `EventEmitter` rather than an `EventTarget`, so listeners are wrapped to
arrive in the `MessageEvent` / `ErrorEvent` shape `WorkerManager` reads `event.data` off.

```typescript
import { Worker as NodeWorker, parentPort } from "node:worker_threads";
import { pathToFileURL } from "node:url";

class WorkerPolyfill extends NodeWorker {
  constructor(scriptUrl: string | URL, options?: WorkerOptions) {
    super(typeof scriptUrl === "string" ? pathToFileURL(scriptUrl) : scriptUrl, options);
  }

  addEventListener(type: WorkerEventType, listener: WorkerEventListener) {
    this.on(type, this.#adapt(type, listener)); // wraps the value as { type, data }
  }
  // removeEventListener takes the same wrapped function back off.
}

const Worker = WorkerPolyfill;
export { Worker, parentPort };
```

Its `WorkerServer` hands `parentPort.postMessage` to `WorkerServerBase` as the `post` option: a
Node worker thread has **no global `postMessage`**, so a server that reached for the global could
receive messages but never reply. It refuses to construct when `parentPort` is null — the main
thread.

**Bun** needs no third file. It implements `node:worker_threads` over the same primitive as its
web `Worker`, so a thread spawned either way is reachable through `parentPort`, and Bun resolves
the `"import"` default to this build. The browser keeps its own file for the one reason Bun never
had: a static `node:worker_threads` import cannot be bundled for it.

Both implementations register a `WorkerServer` singleton into `globalServiceRegistry` under
the `WORKER_SERVER` service token, ensuring the correct server is available in worker contexts
regardless of platform.

### WorkerManager

The `WorkerManager` class (in `common.ts`, platform-agnostic) manages the lifecycle of worker
instances on the main thread:

```typescript
import { WORKER_MANAGER } from "@workglow/util";

const manager = globalServiceRegistry.get(WORKER_MANAGER);
manager.registerWorker("my-worker", () => new Worker("./worker.js"));

const result = await manager.callWorkerFunction<string>("my-worker", "processData", [input]);
```

Key features:

- **Lazy initialization**: Workers can be registered with a factory function and are only
  constructed when first called.
- **Ready handshake**: Workers send a `ready` message advertising their registered functions;
  the manager waits for this before dispatching calls.
- **Three call modes**: `callWorkerFunction` (request/response), `callWorkerStreamFunction`
  (async generator yielding stream chunks), and `callWorkerPreviewFunction` (lightweight
  preview with no abort support).
- **Abort support**: Callers can pass an `AbortSignal`; the manager forwards abort messages to
  the worker.
- **Progress tracking**: Workers can send progress updates during long-running operations.
- **Transferable detection**: The `WorkerServerBase` automatically extracts `TypedArray` buffers,
  `OffscreenCanvas`, `ImageBitmap`, `VideoFrame`, and `MessagePort` transferables from results
  for zero-copy transfer back to the main thread.

### Worker Entry Point (`@workglow/util/worker`)

A separate lightweight sub-path export is provided for code that runs **inside** workers. It
re-exports only the minimal subset needed by worker code — DI, logging, `WorkerServerBase`,
`WorkerManager`, and partial JSON parsing — without the heavy JSON Schema validation libraries
that would bloat worker bundles:

```typescript
// In a worker file:
import { globalServiceRegistry, WORKER_SERVER } from "@workglow/util/worker";
import type { WorkerServerBase } from "@workglow/util/worker";

const server = globalServiceRegistry.get(WORKER_SERVER);
server.registerFunction("processData", async (input, model, onProgress, signal) => {
  // ... process and return result
});
server.sendReady();
```

### Media (`@workglow/util/media`)

The media sub-path provides a `convertImageDataToUseableForm` function that converts between
image representations. The function signature is identical across platforms, but the supported
conversions differ:

**Shared types (`media/image.ts`):**

```typescript
export type ImageChannels = 1 | 3 | 4; // grayscale, rgb, rgba
export type ImageDataSupport =
  | "Blob"
  | "ImageBinary"
  | "ImageBitmap"
  | "OffscreenCanvas"
  | "VideoFrame"
  | "RawImage"
  | "DataUri"
  | "Sharp";

export interface ImageBinary {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  channels: ImageChannels;
}
```

**Browser (`media/image.browser.ts`):**

Supports `ImageBitmap`, `OffscreenCanvas`, `VideoFrame`, `Blob`, `DataUri`, and `ImageBinary`.
Uses `createImageBitmap()` and `OffscreenCanvas` for conversions — APIs only available in browser
contexts.

**Node.js (`media/image.node.ts`):**

Supports `Blob`, `ImageBinary`, and `DataUri`. Does not use browser-only APIs like
`ImageBitmap` or `OffscreenCanvas`. Server-side image processing can use the `Sharp` format
when the `sharp` library is available.

### Compress (`@workglow/util/compress`)

The compress sub-path exposes `compress` and `decompress` functions with identical signatures
across platforms:

```typescript
export async function compress(
  input: string | Uint8Array,
  algorithm: "gzip" | "br" = "gzip"
): Promise<Uint8Array>;

export async function decompress(
  input: Uint8Array,
  algorithm: "gzip" | "br" = "gzip"
): Promise<string>;
```

**Browser (`compress/compress.browser.ts`):**

Uses the Web Streams API with `CompressionStream` / `DecompressionStream`:

```typescript
const compressedStream = sourceBlob.stream().pipeThrough(new CompressionStream(algorithm));
const compressedBuffer = await new Response(compressedStream).arrayBuffer();
return new Uint8Array(compressedBuffer);
```

**Node.js (`compress/compress.node.ts`):**

Uses the built-in `zlib` module with `gzip`/`gunzip` and `brotliCompress`/`brotliDecompress`:

```typescript
import zlib from "zlib";
import { promisify } from "util";

const compressFn = algorithm === "br" ? zlib.brotliCompress : zlib.gzip;
const result = await promisify(compressFn)(Buffer.from(input));
return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
```

---

## Build Configuration

Each entry point is compiled separately by `bun build` with the matching `--target` flag. The
`@workglow/util` package runs all builds concurrently via `concurrently`:

```bash
# Build all JS targets concurrently
bun run build-js
# Which expands to:
concurrently \
  'bun build --target=browser --sourcemap=external --packages=external --outdir ./dist ./src/browser.ts' \
  'bun build --target=node    --sourcemap=external --packages=external --outdir ./dist ./src/node.ts' \
  'bun build --target=browser --sourcemap=external --packages=external --outdir ./dist ./src/schema-entry.ts' \
  'bun build --target=browser --sourcemap=external --packages=external --outdir ./dist ./src/graph-entry.ts' \
  # ... media, compress, worker targets
```

The `--packages=external` flag ensures that all dependencies are left as `import` statements in
the output (not bundled), matching the expectations of the Node.js/Bun module resolvers and
allowing tree-shaking in browser bundlers.

Type declarations are generated separately via `tsc` (TypeScript 7, which is the native compiler). The
`tsconfig.json` lists all entry point files explicitly:

```json
{
  "files": [
    "./src/node.ts",
    "./src/browser.ts",
    "./src/worker-entry.ts",
    "./src/schema-entry.ts",
    "./src/graph-entry.ts",
    "./src/media-browser.ts",
    "./src/media-node.ts",
    "./src/compress-browser.ts",
    "./src/compress-node.ts"
  ],
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

The `composite: true` and `incremental: true` settings enable TypeScript project references and
build caching via `.tsbuildinfo` files.

---

## Adding Platform-Specific Code

To add a new platform-specific module to `@workglow/util` (or any package), follow these steps:

### 1. Create the implementation files

```
src/
  myfeature/
    myfeature.ts            # Shared types and interfaces
    myfeature.browser.ts    # Browser implementation
    myfeature.node.ts       # Node.js implementation (often shared with Bun)
```

### 2. Create entry point files

```
src/
  myfeature-browser.ts     # exports * from "./myfeature/myfeature";
                            # exports * from "./myfeature/myfeature.browser";
  myfeature-node.ts        # exports * from "./myfeature/myfeature";
                            # exports * from "./myfeature/myfeature.node";
```

### 3. Add build scripts to `package.json`

```json
{
  "build-myfeature": "concurrently 'bun run build-myfeature-browser' 'bun run build-myfeature-node'",
  "build-myfeature-browser": "bun build --target=browser --sourcemap=external --packages=external --outdir ./dist ./src/myfeature-browser.ts",
  "build-myfeature-node": "bun build --target=node --sourcemap=external --packages=external --outdir ./dist ./src/myfeature-node.ts"
}
```

Add the new script names to the `build-js` concurrently list.

### 4. Add conditional exports

```json
{
  "./myfeature": {
    "react-native": {
      "types": "./dist/myfeature-browser.d.ts",
      "import": "./dist/myfeature-browser.js"
    },
    "browser": {
      "types": "./dist/myfeature-browser.d.ts",
      "import": "./dist/myfeature-browser.js"
    },
    "bun": {
      "types": "./dist/myfeature-node.d.ts",
      "import": "./dist/myfeature-node.js"
    },
    "types": "./dist/myfeature-node.d.ts",
    "import": "./dist/myfeature-node.js"
  }
}
```

### 5. Update `tsconfig.json`

Add the new entry point files to both the `"files"` array and (if applicable) the `"include"`
patterns.

### 6. Maintain the same function signatures

Both platform implementations must export functions with identical names and compatible type
signatures. Consumers should be able to write `import { myFunction } from "@workglow/util/myfeature"`
without caring which platform they run on.

---

## Testing

Platform-specific code requires testing on the target runtimes. The monorepo supports two test
runners:

- **`bun test`** — runs tests natively in Bun (also exercises browser-compatible code paths since
  Bun supports most Web APIs).
- **`vitest`** — runs tests in a Node.js environment with optional browser mode.

Test files live in `packages/test/src/test/`. To run tests for a specific section:

```bash
bun scripts/test.ts util vitest       # Run util tests via vitest (Node.js)
bun scripts/test.ts util bun          # Run util tests via bun test
```

When testing platform-specific code, write tests against the public API surface (the function
signatures exported from the sub-path) rather than importing from the platform-specific files
directly. This ensures the conditional export resolution is exercised.

For worker-related tests, the test typically registers a worker, waits for the ready handshake,
calls a function, and asserts the result:

```typescript
import { describe, expect, it } from "vitest";
import { WorkerManager } from "@workglow/util";

describe("WorkerManager", () => {
  it("should call a worker function", async () => {
    const manager = new WorkerManager();
    manager.registerWorker("test", () => new Worker("./test-worker.js"));
    const result = await manager.callWorkerFunction<string>("test", "echo", ["hello"]);
    expect(result).toBe("hello");
  });
});
```

---

## Package Configuration Reference

The complete conditional exports map for `@workglow/util`:

```json
{
  "exports": {
    ".": {
      "react-native": { "types": "./dist/browser.d.ts", "import": "./dist/browser.js" },
      "browser": { "types": "./dist/browser.d.ts", "import": "./dist/browser.js" },
      "bun": { "types": "./dist/bun.d.ts", "import": "./dist/bun.js" },
      "types": "./dist/node.d.ts",
      "import": "./dist/node.js"
    },
    "./schema": {
      "types": "./dist/schema-entry.d.ts",
      "import": "./dist/schema-entry.js"
    },
    "./graph": {
      "types": "./dist/graph-entry.d.ts",
      "import": "./dist/graph-entry.js"
    },
    "./media": {
      "react-native": { "types": "./dist/media-browser.d.ts", "import": "./dist/media-browser.js" },
      "browser": { "types": "./dist/media-browser.d.ts", "import": "./dist/media-browser.js" },
      "types": "./dist/media-node.d.ts",
      "import": "./dist/media-node.js"
    },
    "./compress": {
      "react-native": {
        "types": "./dist/compress-browser.d.ts",
        "import": "./dist/compress-browser.js"
      },
      "browser": {
        "types": "./dist/compress-browser.d.ts",
        "import": "./dist/compress-browser.js"
      },
      "types": "./dist/compress-node.d.ts",
      "import": "./dist/compress-node.js"
    },
    "./worker": {
      "react-native": {
        "types": "./dist/worker-browser.d.ts",
        "import": "./dist/worker-browser.js"
      },
      "browser": { "types": "./dist/worker-browser.d.ts", "import": "./dist/worker-browser.js" },
      "types": "./dist/worker-node.d.ts",
      "import": "./dist/worker-node.js"
    }
  }
}
```

The `"files"` field limits the published package to `dist/` and any inline Markdown documentation:

```json
{
  "files": ["dist", "src/**/*.md"]
}
```

This keeps the published package lean — source code is not included, only compiled artifacts and
type declarations.
