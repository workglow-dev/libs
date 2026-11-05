/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BROWSER_CONTROL_TASK_DEPS,
  BrowserClickTask,
  BrowserCloseTabTask,
  BrowserExtractHtmlTask,
  BrowserFillTask,
  BrowserHoverTask,
  BrowserNavigateTask,
  BrowserSelectTask,
  BrowserSessionRegistry,
  BrowserSessionTask,
  BrowserWaitTask,
  getBrowserDeps,
  registerBrowserDeps,
} from "@workglow/browser-control/task";
import type { IExecuteContext } from "@workglow/task-graph";
import { TaskConfigurationError, TaskInvalidInputError } from "@workglow/task-graph";
import { globalServiceRegistry } from "@workglow/util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MockBrowserContext } from "../browser/MockBrowserContext";

// A refusal the caller can fix is a TaskError subclass naming what to fix, so the
// runner keeps it as thrown instead of recording a generic task failure.
describe("browser-control tasks refuse with task errors", () => {
  let sessionId: string;
  const context = { signal: new AbortController().signal } as unknown as IExecuteContext;

  beforeEach(async () => {
    const ctx = new MockBrowserContext();
    await ctx.connect();
    sessionId = BrowserSessionRegistry.register(ctx);
  });
  afterEach(() => {
    BrowserSessionRegistry.clear();
  });

  it("an input that names no element is invalid input", async () => {
    await expect(new BrowserClickTask().execute({ sessionId }, context)).rejects.toBeInstanceOf(
      TaskInvalidInputError
    );
    await expect(
      new BrowserFillTask().execute({ sessionId, value: "x" } as never, context)
    ).rejects.toBeInstanceOf(TaskInvalidInputError);
    await expect(
      new BrowserHoverTask().execute({ sessionId } as never, context)
    ).rejects.toBeInstanceOf(TaskInvalidInputError);
    await expect(
      new BrowserSelectTask().execute({ sessionId, value: "a" } as never, context)
    ).rejects.toBeInstanceOf(TaskInvalidInputError);
  });

  it("a javascript: url is invalid input", async () => {
    await expect(
      new BrowserNavigateTask().execute({ sessionId, url: "javascript:alert(1)" }, context)
    ).rejects.toBeInstanceOf(TaskInvalidInputError);
  });

  it("an unknown or disconnected session is invalid input", async () => {
    await expect(
      new BrowserClickTask().execute({ sessionId: "no-such-session", ref: "e1" }, context)
    ).rejects.toBeInstanceOf(TaskInvalidInputError);
  });

  it("a config missing what the task needs is a configuration error", async () => {
    await expect(
      new BrowserCloseTabTask().execute({ sessionId } as never, context)
    ).rejects.toBeInstanceOf(TaskConfigurationError);
    await expect(
      new BrowserExtractHtmlTask().execute({ sessionId } as never, context)
    ).rejects.toBeInstanceOf(TaskConfigurationError);
    await expect(
      new BrowserWaitTask({ waitFor: "selector" } as never).execute({ sessionId } as never, context)
    ).rejects.toBeInstanceOf(TaskConfigurationError);
  });

  it("unregistered browser deps are a configuration error", () => {
    // Each test file runs in a fresh module registry, and this one registers no deps.
    expect(globalServiceRegistry.has(BROWSER_CONTROL_TASK_DEPS)).toBe(false);
    expect(() => getBrowserDeps()).toThrow(TaskConfigurationError);
  });

  // Runs after the case above, which needs the deps unregistered.
  it("a backend the host does not offer is a configuration error", async () => {
    registerBrowserDeps({
      createContext: () => new MockBrowserContext(),
      availableBackends: ["local"],
      defaultBackend: "local",
      profileStorage: {
        save: async () => {},
        load: async () => null,
        delete: async () => {},
      },
    });
    await expect(
      new BrowserSessionTask({ backend: "cloud" } as never).execute({} as never, context)
    ).rejects.toBeInstanceOf(TaskConfigurationError);
  });
});
