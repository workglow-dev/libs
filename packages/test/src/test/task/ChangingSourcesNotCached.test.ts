/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { ChunkRetrievalTask, KbSearchTask } from "@workglow/ai";
import type { Task } from "@workglow/task-graph";
import { CACHE_REGISTRY, DefaultCacheRegistry } from "@workglow/task-graph";
import { Container, ServiceRegistry } from "@workglow/util";
import { InMemoryTaskOutputRepository } from "@workglow/task-graph/test";
import { WebSearchTask } from "@workglow/web-search";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileGrepTask } from "../../../../tasks/src/task/FileGrepTask.server";
import { FileLoaderTask } from "../../../../tasks/src/task/FileLoaderTask.server";
import { FileSedTask } from "../../../../tasks/src/task/FileSedTask.server";

// These tasks read something that changes between runs -- a file, a knowledge base, the
// web -- keyed by nothing but their input. A cached answer is the source as it was.
describe("tasks reading a changing source are not cached", () => {
  it.each([
    ["FileLoaderTask", FileLoaderTask],
    ["FileGrepTask", FileGrepTask],
    ["FileSedTask", FileSedTask],
    ["KbSearchTask", KbSearchTask],
    ["ChunkRetrievalTask", ChunkRetrievalTask],
    ["WebSearchTask", WebSearchTask],
  ] as const)("%s declares no caching", (_name, TaskClass) => {
    const task = new (TaskClass as unknown as new () => Task)();
    expect(task.getCachePolicy({} as never)).toEqual({ kind: "none" });
  });

  it("a file rewritten between two loads is read afresh", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "changing-source-")));
    const path = join(dir, "doc.txt");
    const url = `file://${path}`;
    const cache = new InMemoryTaskOutputRepository();
    const config = { roots: [dir] } as never;

    writeFileSync(path, "version 1\n");
    const first = await new FileLoaderTask(config).run({ url } as never, { outputCache: cache });
    writeFileSync(path, "version 2\n");
    const second = await new FileLoaderTask(config).run({ url } as never, { outputCache: cache });

    expect((first as { text: string }).text).toContain("version 1");
    expect((second as { text: string }).text).toContain("version 2");
  });

  // The readers own a FetchUrlTask for http(s). Their own outputs are uncached, but the
  // owned fetch is a task with the default policy: it answered the second load from the
  // first one's response.
  it("a url whose body changes between two loads is fetched afresh", async () => {
    let body = "version 1\n";
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}/doc.txt`;
      // A host's cache arrives through the registry, which owned children share.
      const registry = new ServiceRegistry(new Container());
      registry.registerInstance(
        CACHE_REGISTRY,
        new DefaultCacheRegistry({ deterministic: new InMemoryTaskOutputRepository() })
      );
      const first = await new FileLoaderTask().run({ url } as never, { registry });
      body = "version 2\n";
      const second = await new FileLoaderTask().run({ url } as never, { registry });
      expect((first as { text: string }).text).toContain("version 1");
      expect((second as { text: string }).text).toContain("version 2");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
