/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { ChunkRetrievalTask, KbSearchTask } from "@workglow/ai";
import type { Task } from "@workglow/task-graph";
import { InMemoryTaskOutputRepository } from "@workglow/task-graph/test";
import { WebSearchTask } from "@workglow/web-search";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
});
