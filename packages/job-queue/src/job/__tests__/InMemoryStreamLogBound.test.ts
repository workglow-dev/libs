/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { InMemoryQueueStorage, type StreamChunkRow } from "@workglow/job-queue";
import { uuid4 } from "@workglow/util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The replay log used to be appended to unconditionally, so a streamed BODY
 * left a second copy of itself on the heap until the retention deadline — a
 * multi-GB archive fetched through the queue cost multi-GB of resident memory
 * after the graph consuming it had already finished. These pin the bound and
 * the honesty of what happens once it bites.
 */
describe("InMemoryQueueStorage stream log bound", () => {
  let storage: InMemoryQueueStorage<Record<string, unknown>, Record<string, unknown>>;
  const MB = 1024 * 1024;
  const delta = (bytes: number) => ({
    type: "binary-delta",
    port: "body",
    binaryDelta: new Uint8Array(bytes),
  });

  beforeEach(async () => {
    storage = new InMemoryQueueStorage(`bound-${uuid4()}`);
    await storage.migrate();
  });
  afterEach(async () => {
    await storage.deleteAll();
  });

  it("keeps a large body's replay log bounded instead of retaining every byte", async () => {
    // 64 MB of body through a log capped at 8 MB.
    for (let i = 0; i < 64; i++) await storage.publishStreamChunk!("big", delta(MB));

    const replayed: StreamChunkRow[] = [];
    // Resuming from the tail: nothing this subscriber needs was dropped.
    storage.subscribeToStream!("big", 63, (r) => replayed.push(r));
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.seq).toBe(64);

    // What survives is a bounded suffix, not the whole stream.
    const all: StreamChunkRow[] = [];
    storage.subscribeToStream!("big", 60, (r) => all.push(r));
    expect(all.length).toBeLessThanOrEqual(9);
  });

  it("reports a replay it can no longer serve rather than a body with a hole", async () => {
    for (let i = 0; i < 64; i++) await storage.publishStreamChunk!("holed", delta(MB));

    const seen: StreamChunkRow[] = [];
    storage.subscribeToStream!("holed", 0, (r) => seen.push(r));

    // One error, not a truncated suffix presented as the whole body.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.event.type).toBe("error");
    expect(String((seen[0]!.event as { error?: { message?: string } }).error?.message)).toContain(
      "Stream replay unavailable"
    );
  });

  it("never drops the row it just published, even one larger than the cap", async () => {
    await storage.publishStreamChunk!("huge", delta(32 * MB));
    const seen: StreamChunkRow[] = [];
    storage.subscribeToStream!("huge", 0, (r) => seen.push(r));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.seq).toBe(1);
  });

  it("leaves an ordinary small stream fully replayable", async () => {
    for (let i = 0; i < 20; i++) {
      await storage.publishStreamChunk!("small", { type: "text-delta", port: "p", textDelta: "x" });
    }
    const seen: StreamChunkRow[] = [];
    storage.subscribeToStream!("small", 0, (r) => seen.push(r));
    expect(seen.map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});
