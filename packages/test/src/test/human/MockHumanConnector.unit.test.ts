/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IHumanRequest } from "@workglow/util";
import { describe, expect, it } from "vitest";

import { MockHumanConnector } from "@workglow/test-contract/human-connector";

function elicitReq(requestId: string): IHumanRequest {
  return {
    requestId,
    targetHumanId: "default",
    kind: "elicit",
    message: "test",
    contentSchema: { type: "object", properties: {}, additionalProperties: true },
    contentData: undefined,
    expectsResponse: true,
    mode: "single",
    metadata: undefined,
  };
}

describe("MockHumanConnector — defaults", () => {
  it("auto-accepts when no script entry is queued", async () => {
    const c = new MockHumanConnector();
    const ac = new AbortController();
    const res = await c.send(elicitReq("r1"), ac.signal);
    expect(res.requestId).toBe("r1");
    expect(res.action).toBe("accept");
    expect(res.done).toBe(true);
    expect(res.content).toBeUndefined();
  });

  it("records every request received", async () => {
    const c = new MockHumanConnector();
    const ac = new AbortController();
    await c.send(elicitReq("r1"), ac.signal);
    await c.send(elicitReq("r2"), ac.signal);
    expect(c.script.received.map((r) => r.requestId)).toEqual(["r1", "r2"]);
  });
});

describe("MockHumanConnector — scripted", () => {
  it("consumes pushed responses FIFO", async () => {
    const c = new MockHumanConnector();
    c.script.push({ requestId: "ignored", action: "decline", content: undefined, done: true });
    c.script.push((req) => ({
      requestId: req.requestId,
      action: "accept",
      content: { ok: true },
      done: true,
    }));

    const a = await c.send(elicitReq("r1"), new AbortController().signal);
    const b = await c.send(elicitReq("r2"), new AbortController().signal);

    expect(a.action).toBe("decline");
    // Pushed exact responses still echo the actual requestId from the request,
    // so consumers can rely on requestId being correct regardless of script entry.
    expect(a.requestId).toBe("r1");
    expect(b.action).toBe("accept");
    expect(b.requestId).toBe("r2");
    expect(b.content).toEqual({ ok: true });
  });

  it("falls back to default action once the queue is drained", async () => {
    const c = new MockHumanConnector();
    c.script.push({ requestId: "x", action: "decline", content: undefined, done: true });
    const ac = new AbortController();
    const a = await c.send(elicitReq("r1"), ac.signal);
    const b = await c.send(elicitReq("r2"), ac.signal);
    expect(a.action).toBe("decline");
    expect(b.action).toBe("accept");
  });

  it("clear() empties queue and received history", async () => {
    const c = new MockHumanConnector();
    c.script.push({ requestId: "x", action: "decline", content: undefined, done: true });
    await c.send(elicitReq("r1"), new AbortController().signal);
    expect(c.script.received).toHaveLength(1);
    c.script.clear();
    expect(c.script.received).toHaveLength(0);
    const after = await c.send(elicitReq("r2"), new AbortController().signal);
    expect(after.action).toBe("accept");
  });
});

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  return e.name === "AbortError" || /abort/i.test(e.message ?? "");
}

describe("MockHumanConnector — deferred + abort", () => {
  it("blocks send() until release()", async () => {
    const c = new MockHumanConnector();
    const handle = c.script.pushDeferred();
    const ac = new AbortController();
    const promise = c.send(elicitReq("r1"), ac.signal);
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    handle.release({ requestId: "x", action: "accept", content: { ok: 1 }, done: true });
    const res = await promise;
    expect(res.action).toBe("accept");
    expect(res.content).toEqual({ ok: 1 });
  });

  it("rejects with AbortError when signal is already aborted before send", async () => {
    const c = new MockHumanConnector();
    const ac = new AbortController();
    ac.abort();
    let caught: unknown;
    try {
      await c.send(elicitReq("r1"), ac.signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isAbortError(caught)).toBe(true);
  });

  it("rejects with AbortError when signal aborts during a deferred wait", async () => {
    const c = new MockHumanConnector();
    c.script.pushDeferred();
    const ac = new AbortController();
    const promise = c.send(elicitReq("r1"), ac.signal);
    setTimeout(() => ac.abort(), 10);
    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isAbortError(caught)).toBe(true);
  });

  it("releasing after rejection is a no-op (does not throw, does not affect later sends)", async () => {
    const c = new MockHumanConnector();
    const handle = c.script.pushDeferred();
    const ac = new AbortController();
    const promise = c.send(elicitReq("r1"), ac.signal);
    setTimeout(() => ac.abort(), 5);
    try {
      await promise;
    } catch {
      // expected abort
    }
    expect(() =>
      handle.release({ requestId: "x", action: "accept", content: undefined, done: true })
    ).not.toThrow();
    const res = await c.send(elicitReq("r2"), new AbortController().signal);
    expect(res.action).toBe("accept");
  });
});

describe("MockHumanConnector — followUp", () => {
  it("exposes followUp when supportsFollowUp is true (default)", () => {
    const c = new MockHumanConnector();
    expect(typeof c.followUp).toBe("function");
  });

  it("does NOT expose followUp when supportsFollowUp is false", () => {
    const c = new MockHumanConnector({ supportsFollowUp: false });
    expect(c.followUp).toBeUndefined();
  });

  it("followUp consumes the next scripted entry like send()", async () => {
    const c = new MockHumanConnector();
    c.script.push({ requestId: "x", action: "accept", content: { step: 1 }, done: false });
    c.script.push({ requestId: "x", action: "accept", content: { step: 2 }, done: true });
    const ac = new AbortController();
    const first = await c.send(elicitReq("r1"), ac.signal);
    expect(first.done).toBe(false);
    const second = await c.followUp!(elicitReq("r1"), first, ac.signal);
    expect(second.done).toBe(true);
    expect(second.content).toEqual({ step: 2 });
  });
});

function notifyReq(requestId: string): IHumanRequest {
  return {
    requestId,
    targetHumanId: "default",
    kind: "notify",
    message: "ping",
    contentSchema: { type: "object", properties: {}, additionalProperties: true },
    contentData: undefined,
    expectsResponse: false,
    mode: "single",
    metadata: undefined,
  };
}

function displayReq(requestId: string): IHumanRequest {
  return {
    requestId,
    targetHumanId: "default",
    kind: "display",
    message: "view",
    contentSchema: { type: "object", properties: {}, additionalProperties: true },
    contentData: { x: 1 },
    expectsResponse: false,
    mode: "single",
    metadata: undefined,
  };
}

describe("MockHumanConnector — notify/display fast-resolve", () => {
  it("notify fast-resolves and does not consume a queued elicit response", async () => {
    const c = new MockHumanConnector();
    c.script.push({
      requestId: "queued",
      action: "accept",
      content: { tag: "queued" },
      done: true,
    });

    const ac = new AbortController();
    const notifyRes = await c.send(notifyReq("n1"), ac.signal);
    expect(notifyRes.action).toBe("accept");
    expect(notifyRes.done).toBe(true);
    expect(notifyRes.content).toBeUndefined();

    const elicitRes = await c.send(elicitReq("e1"), ac.signal);
    expect(elicitRes.requestId).toBe("e1");
    expect(elicitRes.content).toEqual({ tag: "queued" });
  });

  it("display fast-resolves and does not consume a queued elicit response", async () => {
    const c = new MockHumanConnector();
    c.script.push({
      requestId: "queued",
      action: "accept",
      content: { tag: "queued" },
      done: true,
    });

    const ac = new AbortController();
    const displayRes = await c.send(displayReq("d1"), ac.signal);
    expect(displayRes.action).toBe("accept");
    expect(displayRes.done).toBe(true);
    expect(displayRes.content).toBeUndefined();

    const elicitRes = await c.send(elicitReq("e1"), ac.signal);
    expect(elicitRes.requestId).toBe("e1");
    expect(elicitRes.content).toEqual({ tag: "queued" });
  });

  it("notify and display still record received requests", async () => {
    const c = new MockHumanConnector();
    const ac = new AbortController();
    await c.send(notifyReq("n1"), ac.signal);
    await c.send(displayReq("d1"), ac.signal);
    expect(c.script.received.map((r) => r.requestId)).toEqual(["n1", "d1"]);
  });
});

describe("MockHumanConnector — content belongs to an accepted elicit", () => {
  // `IHumanResponse.content` is documented as present only for an accepted
  // elicit. The reference connector is the yardstick the conformance suite
  // measures adapters against, so a script that puts content beside a refusal
  // must not be able to hand it back — otherwise the suite cannot fail an
  // adapter that leaks a declined form's data onto `HumanInputTask`'s outputs.
  it.each(["decline", "cancel"] as const)(
    "drops scripted content on an elicit the person answered with %s",
    async (action) => {
      const c = new MockHumanConnector();
      c.script.push({ requestId: "x", action, content: { secret: "leaked" }, done: true });
      const ac = new AbortController();
      const res = await c.send(elicitReq("r1"), ac.signal);
      expect(res.action).toBe(action);
      expect(res.content).toBeUndefined();
    }
  );

  it("keeps scripted content on an accepted elicit", async () => {
    const c = new MockHumanConnector();
    c.script.push({ requestId: "x", action: "accept", content: { kept: true }, done: true });
    const ac = new AbortController();
    const res = await c.send(elicitReq("r1"), ac.signal);
    expect(res.content).toEqual({ kept: true });
  });
});

describe("MockHumanConnector — clear() rejects pending deferreds", () => {
  it("clear() unblocks an in-flight send() awaiting a deferred", async () => {
    const c = new MockHumanConnector();
    c.script.pushDeferred();
    const ac = new AbortController();
    const promise = c.send(elicitReq("r1"), ac.signal);

    // Allow send() to shift and start awaiting before we clear.
    await Promise.resolve();
    c.script.clear();

    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isAbortError(caught)).toBe(true);
  });
});
