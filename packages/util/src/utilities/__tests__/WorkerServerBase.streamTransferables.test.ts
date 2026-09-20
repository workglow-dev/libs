/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { WorkerServerBase } from "@workglow/util/worker";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface PostedMessage {
  readonly msg: { readonly type: string; readonly id?: string; readonly data?: any };
  readonly transfer: readonly unknown[];
}

// WorkerServerBase posts via the global `postMessage`. Capture BOTH the message
// and the transfer list (2nd positional arg) so we can assert binary buffers
// are transferred rather than structure-cloned.
function installPostMessageStub(): { captured: PostedMessage[]; restore(): void } {
  const captured: PostedMessage[] = [];
  const original = (globalThis as { postMessage?: unknown }).postMessage;
  (globalThis as unknown as { postMessage: (m: any, t?: readonly unknown[]) => void }).postMessage =
    (m, t) => {
      captured.push({ msg: m, transfer: t ?? [] });
    };
  return {
    captured,
    restore() {
      if (typeof original === "function") {
        (globalThis as { postMessage?: unknown }).postMessage = original;
      } else {
        delete (globalThis as { postMessage?: unknown }).postMessage;
      }
    },
  };
}

describe("WorkerServerBase.postStreamChunk transferables", () => {
  let stub: { captured: PostedMessage[]; restore(): void };

  beforeEach(() => {
    stub = installPostMessageStub();
  });
  afterEach(() => {
    stub.restore();
  });

  it("transfers binary-delta buffers and clones text-delta", async () => {
    const server = new WorkerServerBase();
    server.registerRunFunction("emitStuff", async (_i, _m, _sig, emit) => {
      void emit({ type: "binary-delta", port: "bytes", binaryDelta: new Uint8Array([1, 2, 3]) });
      void emit({ type: "text-delta", port: "text", textDelta: "hi" });
    });

    await server.handleMessage({
      type: "message",
      data: {
        id: "r1",
        type: "call",
        functionName: "emitStuff",
        args: [{}, undefined, undefined, undefined],
        run: true,
      },
    });

    const chunks = stub.captured.filter((c) => c.msg.type === "stream_chunk");
    expect(chunks.map((c) => c.msg.data.type)).toEqual(["binary-delta", "text-delta"]);

    // binary-delta: the backing ArrayBuffer rides the transfer list.
    const binTransfer = chunks[0].transfer;
    expect(binTransfer.length).toBe(1);
    expect(binTransfer[0]).toBeInstanceOf(ArrayBuffer);
    expect((binTransfer[0] as ArrayBuffer).byteLength).toBe(3);

    // text-delta: nothing to transfer — cloned exactly as before.
    expect(chunks[1].transfer).toEqual([]);

    // Terminal completion still posts.
    expect(stub.captured.some((c) => c.msg.type === "complete")).toBe(true);
  });

  it("clones (does not transfer) an empty binary-delta payload", async () => {
    const server = new WorkerServerBase();
    server.registerRunFunction("emitEmpty", async (_i, _m, _sig, emit) => {
      void emit({ type: "binary-delta", port: "bytes", binaryDelta: new Uint8Array(0) });
    });

    await server.handleMessage({
      type: "message",
      data: {
        id: "rEmpty",
        type: "call",
        functionName: "emitEmpty",
        args: [{}, undefined, undefined, undefined],
        run: true,
      },
    });

    const chunk = stub.captured.find((c) => c.msg.type === "stream_chunk")!;
    expect(chunk.transfer).toEqual([]);
    expect(stub.captured.some((c) => c.msg.type === "complete")).toBe(true);
  });

  it("clones (does not transfer) an already-detached buffer instead of failing the post", async () => {
    const server = new WorkerServerBase();
    const bytes = new Uint8Array([1, 2, 3]);
    // Detach the backing buffer, as a prior transfer of retained state would.
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    expect(bytes.buffer.byteLength).toBe(0);
    server.registerRunFunction("emitDetached", async (_i, _m, _sig, emit) => {
      void emit({ type: "binary-delta", port: "bytes", binaryDelta: bytes });
    });

    await server.handleMessage({
      type: "message",
      data: {
        id: "rDetached",
        type: "call",
        functionName: "emitDetached",
        args: [{}, undefined, undefined, undefined],
        run: true,
      },
    });

    // A detached buffer must never ride the transfer list (transferring it
    // throws DataCloneError); the event posts without one and the job completes.
    const chunk = stub.captured.find((c) => c.msg.type === "stream_chunk")!;
    expect(chunk.transfer).toEqual([]);
    expect(stub.captured.some((c) => c.msg.type === "complete")).toBe(true);
  });

  it("degrades to a clone post when the transfer-list post throws", async () => {
    // Simulate a platform refusing the transferable: the first, transfer-list
    // post of a stream chunk throws; the fallback must re-post as a clone
    // instead of failing the job.
    const posts: PostedMessage[] = [];
    (
      globalThis as unknown as { postMessage: (m: any, t?: readonly unknown[]) => void }
    ).postMessage = (m, t) => {
      if (m.type === "stream_chunk" && t !== undefined && t.length > 0) {
        throw new Error("simulated DataCloneError");
      }
      posts.push({ msg: m, transfer: t ?? [] });
    };

    const server = new WorkerServerBase();
    server.registerRunFunction("emitOwned", async (_i, _m, _sig, emit) => {
      void emit({ type: "binary-delta", port: "bytes", binaryDelta: new Uint8Array([4, 5]) });
    });

    await server.handleMessage({
      type: "message",
      data: {
        id: "rFallback",
        type: "call",
        functionName: "emitOwned",
        args: [{}, undefined, undefined, undefined],
        run: true,
      },
    });

    const chunk = posts.find((c) => c.msg.type === "stream_chunk")!;
    expect(chunk).toBeDefined();
    expect(chunk.transfer).toEqual([]);
    expect(Array.from(chunk.msg.data.binaryDelta as Uint8Array)).toEqual([4, 5]);
    expect(posts.some((c) => c.msg.type === "complete")).toBe(true);
  });

  it("clones (does not transfer) a partial-view binary-delta so a shared buffer is not detached", async () => {
    const server = new WorkerServerBase();
    // A subarray view: byteOffset 1, spans 2 of the backing buffer's 5 bytes.
    // Transferring its backing buffer would detach bytes a later chunk may alias.
    const backing = new Uint8Array([9, 8, 7, 6, 5]);
    const view = backing.subarray(1, 3); // [8, 7]
    server.registerRunFunction("emitView", async (_i, _m, _sig, emit) => {
      void emit({ type: "binary-delta", port: "bytes", binaryDelta: view });
    });

    await server.handleMessage({
      type: "message",
      data: {
        id: "r2",
        type: "call",
        functionName: "emitView",
        args: [{}, undefined, undefined, undefined],
        run: true,
      },
    });

    const chunk = stub.captured.find((c) => c.msg.type === "stream_chunk")!;
    // Partial view → nothing transferred (structured-cloned), backing not detached.
    expect(chunk.transfer).toEqual([]);
    expect(backing.byteLength).toBe(5); // still intact
    expect(Array.from(chunk.msg.data.binaryDelta as Uint8Array)).toEqual([8, 7]);
  });
});
