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

  it("bounds a run of object deltas, whose payload grows per row", async () => {
    // Structured generation publishes each `objectDelta` as a progressively
    // more complete snapshot, so N deltas retain roughly N × the final size.
    // While every non-binary row was charged a flat 64 bytes the cap could not
    // see that at all: 1,000 rows reported 64 KB against an 8 MB cap, so
    // nothing was ever trimmed and ~32 MB of payload sat on the heap until the
    // retention sweep — a log that looked bounded and was not.
    const field = "y".repeat(32 * 1024);
    for (let i = 1; i <= 1000; i++) {
      await storage.publishStreamChunk!("objects", {
        type: "object-delta",
        port: "object",
        objectDelta: { [`f${i}`]: field },
      });
    }

    const all: StreamChunkRow[] = [];
    storage.subscribeToStream!("objects", 0, (r) => all.push(r));

    // Eviction happened: the log holds a bounded suffix, and the refusal that
    // replaces the dropped prefix is the first thing a full replay sees.
    expect(all[0]!.event.type).toBe("error");
    expect(String((all[0]!.event as { error?: { message?: string } }).error?.message)).toContain(
      "Stream replay unavailable"
    );

    const tail: StreamChunkRow[] = [];
    storage.subscribeToStream!("objects", 999, (r) => tail.push(r));
    expect(tail).toHaveLength(1);
    expect(tail[0]!.seq).toBe(1000);
  });

  it("bounds a run of whole-output snapshots", async () => {
    // Replace-mode ports and the agent turn loop publish a whole `Output` per
    // row, which has the same shape as the object-delta case above.
    const data = { transcript: "z".repeat(64 * 1024) };
    for (let i = 0; i < 500; i++) {
      await storage.publishStreamChunk!("snapshots", { type: "snapshot", data });
    }

    const all: StreamChunkRow[] = [];
    storage.subscribeToStream!("snapshots", 0, (r) => all.push(r));
    expect(all[0]!.event.type).toBe("error");

    const tail: StreamChunkRow[] = [];
    storage.subscribeToStream!("snapshots", 499, (r) => tail.push(r));
    expect(tail).toHaveLength(1);
    expect(tail[0]!.seq).toBe(500);
  });

  it("charges a text delta its own length", async () => {
    // A long-running token stream is the other way a flat per-row charge lets
    // the log outgrow the cap.
    const chunk = "t".repeat(64 * 1024);
    for (let i = 0; i < 300; i++) {
      await storage.publishStreamChunk!("tokens", {
        type: "text-delta",
        port: "text",
        textDelta: chunk,
      });
    }

    const all: StreamChunkRow[] = [];
    storage.subscribeToStream!("tokens", 0, (r) => all.push(r));
    expect(all[0]!.event.type).toBe("error");

    const tail: StreamChunkRow[] = [];
    storage.subscribeToStream!("tokens", 299, (r) => tail.push(r));
    expect(tail).toHaveLength(1);
    expect(tail[0]!.seq).toBe(300);
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
