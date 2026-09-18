/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { InMemoryQueueStorage } from "@workglow/job-queue";
import { uuid4 } from "@workglow/util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * An in-process carrier publishes inside the emitting job's own awaited
 * dispatch, so awaiting the subscriber is the ONLY thing that paces the
 * producer. Resolving on the append alone let a fetch outrun its consumer and
 * queue the entire body downstream — the bytes moved out of the replay log and
 * into the consumer's pending queue, which is not a fix.
 */
describe("InMemoryQueueStorage stream channel backpressure", () => {
  let storage: InMemoryQueueStorage<Record<string, unknown>, Record<string, unknown>>;

  beforeEach(async () => {
    storage = new InMemoryQueueStorage(`bp-${uuid4()}`);
    await storage.migrate();
  });
  afterEach(async () => {
    await storage.deleteAll();
  });

  it("does not resolve a publish until a slow subscriber has taken the row", async () => {
    let release: (() => void) | undefined;
    const taken = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.subscribeToStream!("paced", 0, () => taken);

    let settled = false;
    const published = storage.publishStreamChunk!("paced", {
      type: "text-delta",
      port: "p",
      textDelta: "a",
    }).then(() => {
      settled = true;
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false); // still parked on the consumer

    release!();
    await published;
    expect(settled).toBe(true);
  });

  it("lets the producer continue when a subscriber fails", async () => {
    storage.subscribeToStream!("failing", 0, () => Promise.reject(new Error("consumer blew up")));
    await expect(
      storage.publishStreamChunk!("failing", { type: "text-delta", port: "p", textDelta: "a" })
    ).resolves.toBeUndefined();
  });

  it("still resolves with no subscriber attached", async () => {
    await expect(
      storage.publishStreamChunk!("nobody", { type: "text-delta", port: "p", textDelta: "a" })
    ).resolves.toBeUndefined();
  });
});
