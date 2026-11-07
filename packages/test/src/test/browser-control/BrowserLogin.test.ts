/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserLoginTask, BrowserSessionRegistry } from "@workglow/browser-control/task";
import type { IExecuteContext } from "@workglow/task-graph";
import { TaskConfigurationError, TaskFailedError } from "@workglow/task-graph";
import type { IHumanConnector, IHumanRequest } from "@workglow/util";
import { Container, HUMAN_CONNECTOR, ServiceRegistry } from "@workglow/util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MockBrowserContext } from "../browser/MockBrowserContext";

// Manual login used to report "Waiting for manual login..." and return at once, so
// the next task ran before anyone had logged in.
describe("BrowserLoginTask manual mode waits for the person", () => {
  let ctx: MockBrowserContext;
  let sessionId: string;
  beforeEach(async () => {
    ctx = new MockBrowserContext();
    await ctx.connect();
    sessionId = BrowserSessionRegistry.register(ctx);
  });
  afterEach(() => BrowserSessionRegistry.clear());

  function contextWith(answer: "accept" | "decline" | "cancel" | undefined) {
    const asked: IHumanRequest[] = [];
    const registry = new ServiceRegistry(new Container());
    if (answer) {
      const connector: IHumanConnector = {
        send: async (request) => {
          asked.push(request);
          // Opened before asking: the person logs in on the page the task navigated to.
          expect(ctx.calls.some((c) => c.method === "navigate")).toBe(true);
          return { requestId: request.requestId, action: answer, content: undefined, done: true };
        },
      };
      registry.registerInstance(HUMAN_CONNECTOR, connector);
    }
    const context = {
      signal: new AbortController().signal,
      updateProgress: async () => {},
      registry,
    } as unknown as IExecuteContext;
    return { context, asked };
  }

  it("asks the person to log in as a confirm and returns once they continue", async () => {
    const { context, asked } = contextWith("accept");
    const out = await new BrowserLoginTask().execute(
      { sessionId, url: "https://example.com/login" },
      context
    );
    expect(out).toEqual({ sessionId });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.kind).toBe("confirm");
    expect(asked[0]!.message).toContain("https://example.com/login");
  });

  it("fails when the person does not continue", async () => {
    for (const answer of ["decline", "cancel"] as const) {
      const { context } = contextWith(answer);
      await expect(
        new BrowserLoginTask().execute({ sessionId, url: "https://example.com/login" }, context)
      ).rejects.toBeInstanceOf(TaskFailedError);
    }
  });

  it("refuses up front when no host can ask a person", async () => {
    const { context } = contextWith(undefined);
    await expect(
      new BrowserLoginTask().execute({ sessionId, url: "https://example.com/login" }, context)
    ).rejects.toBeInstanceOf(TaskConfigurationError);
    expect(ctx.calls.some((c) => c.method === "navigate")).toBe(false);
  });

  it("offers no unimplemented modes", () => {
    expect(() => new BrowserLoginTask({ mode: "credential" } as never)).toThrow(
      TaskConfigurationError
    );
    expect(() => new BrowserLoginTask({ mode: "ai" } as never)).toThrow(TaskConfigurationError);
  });
});
