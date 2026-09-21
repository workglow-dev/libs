/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { InMemoryQueueStorage } from "@workglow/job-queue";
import { sleep } from "@workglow/util";
import { afterEach, describe, expect, it } from "vitest";

interface TestInput {
  readonly data: string;
}

interface TestOutput {
  readonly result: string;
}

/**
 * The stream subscriber's return type is `unknown`, so a consumer that
 * reassembles a stream — decode, write to a file, push onto a channel — is
 * exactly the shape that becomes `async`. Whether its rejection is isolated or
 * fatal must not depend on which side of the live/replay split the row it was
 * handed came from: the subscriber cannot see that split and does not control
 * it. An unawaited rejection is an unhandled rejection, which Node terminates
 * the process for by default.
 */
describe("InMemoryQueueStorage stream subscriber isolation", () => {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason);
  };

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    rejections.length = 0;
  });

  function watchForUnhandledRejections(): void {
    process.on("unhandledRejection", onUnhandled);
  }

  function storage(): InMemoryQueueStorage<TestInput, TestOutput> {
    return new InMemoryQueueStorage<TestInput, TestOutput>("stream-isolation");
  }

  it("contains an async subscriber that rejects during replay", async () => {
    watchForUnhandledRejections();
    const s = storage();
    await s.publishStreamChunk("job1", { type: "text-delta", text: "hi" });

    const unsubscribe = s.subscribeToStream("job1", 0, async () => {
      throw new Error("subscriber blew up during replay");
    });

    expect(typeof unsubscribe).toBe("function");
    await sleep(50);
    expect(rejections).toEqual([]);
    unsubscribe();
  });

  it("contains an async subscriber that rejects on the replay-unavailable refusal", async () => {
    watchForUnhandledRejections();
    const s = storage();
    // Push past the replay log's byte cap so the head is evicted and a
    // subscriber asking from seq 0 gets the refusal row rather than a spliced
    // body. That branch fires under memory pressure, which is when a resuming
    // consumer is most likely to throw.
    // Binary deltas are the events the log measures exactly, so three 4 MiB
    // rows carry it past the 8 MiB cap; a text delta is charged a flat 64.
    for (let i = 0; i < 3; i++) {
      await s.publishStreamChunk("job2", {
        type: "binary-delta",
        binaryDelta: new Uint8Array(4 * 1024 * 1024),
      });
    }

    const seen: string[] = [];
    const unsubscribe = s.subscribeToStream("job2", 0, async (row) => {
      seen.push(row.event.type);
      throw new Error("subscriber blew up on the refusal");
    });

    await sleep(50);
    expect(seen).toEqual(["error"]);
    expect(rejections).toEqual([]);
    unsubscribe();
  });

  it("contains a synchronous throw as well", async () => {
    watchForUnhandledRejections();
    const s = storage();
    await s.publishStreamChunk("job3", { type: "text-delta", text: "hi" });

    expect(() =>
      s.subscribeToStream("job3", 0, () => {
        throw new Error("synchronous subscriber throw");
      })
    ).not.toThrow();

    await sleep(50);
    expect(rejections).toEqual([]);
  });

  it("still delivers replayed rows to a subscriber that does not throw", async () => {
    const s = storage();
    await s.publishStreamChunk("job4", { type: "text-delta", text: "a" });
    await s.publishStreamChunk("job4", { type: "text-delta", text: "b" });

    const seen: number[] = [];
    const unsubscribe = s.subscribeToStream("job4", 0, async (row) => {
      seen.push(row.seq);
    });

    await sleep(50);
    expect(seen).toEqual([1, 2]);
    unsubscribe();
  });
});
