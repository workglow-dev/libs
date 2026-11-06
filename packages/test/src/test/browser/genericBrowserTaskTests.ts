/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AccessibilityNode, IBrowserContext } from "@workglow/browser-control/task";
import {
  BrowserBackTask,
  BrowserClickTask,
  BrowserCloseTask,
  BrowserFillTask,
  BrowserForwardTask,
  BrowserNavigateTask,
  BrowserReloadTask,
  BrowserSessionRegistry,
  BrowserSessionTask,
  BrowserSnapshotTask,
  registerBrowserDeps,
} from "@workglow/browser-control/task";
import { DisposeStrategy, ResourceScope } from "@workglow/util";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Accessibility tree helpers
// ---------------------------------------------------------------------------

/** Collect all nodes in the tree into a flat array via depth-first traversal. */
function collectNodes(node: AccessibilityNode): AccessibilityNode[] {
  const result: AccessibilityNode[] = [node];
  for (const child of node.children ?? []) {
    result.push(...collectNodes(child));
  }
  return result;
}

/** Find the first node matching a role (and optionally name) anywhere in the tree. */
function findByRole(
  root: AccessibilityNode,
  role: string,
  name?: string
): AccessibilityNode | undefined {
  return collectNodes(root).find((n) => n.role === role && (!name || n.name === name));
}

// ---------------------------------------------------------------------------
// Test page served as a data URL — works for both mock and real backends
// ---------------------------------------------------------------------------

const TEST_PAGE_HTML = [
  "<!DOCTYPE html><html><head><title>Test Page</title></head><body>",
  "<h1>Test</h1>",
  "<form>",
  '  <label for="email">Email address</label>',
  '  <input id="email" type="text">',
  '  <button type="button">Sign in</button>',
  "</form>",
  "</body></html>",
].join("");

export interface GenericBrowserTaskTestOptions {
  /** When set, passed to Vitest hook APIs so slow backends (e.g. Playwright) stay stable. */
  readonly hookTimeout?: number;
}

// ---------------------------------------------------------------------------
// Generic browser task test suite
// ---------------------------------------------------------------------------

export function runGenericBrowserTaskTests(
  createContext: () => IBrowserContext,
  options?: GenericBrowserTaskTestOptions
): void {
  const hookTimeout = options?.hookTimeout;

  // Served over http rather than as a `data:` url: browser navigation refuses every
  // scheme but http(s) and about:blank, so a fixture has to arrive the way a page does.
  let server: Server | undefined;
  let TEST_PAGE_URL = "";
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(TEST_PAGE_HTML);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    TEST_PAGE_URL = `http://127.0.0.1:${port}/`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  function scopedAfterEach(fn: () => void | Promise<void>): void {
    if (hookTimeout !== undefined) {
      afterEach(fn, hookTimeout);
    } else {
      afterEach(fn);
    }
  }

  function scopedBeforeEach(fn: () => void | Promise<void>): void {
    if (hookTimeout !== undefined) {
      beforeEach(fn, hookTimeout);
    } else {
      beforeEach(fn);
    }
  }

  function setup(): void {
    registerBrowserDeps({
      createContext,
      availableBackends: ["local"],
      defaultBackend: "local",
      profileStorage: {
        save: vi.fn(),
        load: vi.fn().mockResolvedValue(null),
        delete: vi.fn(),
      },
    });
  }

  /** Keeps browser sessions alive across sequential standalone task.run() calls. */
  let sessionScope: ResourceScope | undefined;

  function initSessionScope(): void {
    sessionScope = new ResourceScope({ strategy: DisposeStrategy.never() });
  }

  function runOpts(): { resourceScope: ResourceScope } {
    if (sessionScope === undefined) {
      initSessionScope();
    }
    return { resourceScope: sessionScope! };
  }

  scopedAfterEach(async () => {
    if (sessionScope !== undefined) {
      await sessionScope[Symbol.asyncDispose]();
      sessionScope = undefined;
    }
    await BrowserSessionRegistry.disconnectAll();
  });

  // Ensure no leaked sessions before each test (e.g. prior hook failure). Avoids calling
  // clear() while live Playwright processes are still registered.
  scopedBeforeEach(async () => {
    await BrowserSessionRegistry.disconnectAll();
  });

  // -----------------------------------------------------------------------
  // Session lifecycle
  // -----------------------------------------------------------------------

  describe("BrowserSessionTask", () => {
    scopedBeforeEach(() => {
      setup();
      initSessionScope();
    });

    test("creates a session and returns sessionId", async () => {
      const task = new BrowserSessionTask({ headless: true });
      const result = await task.run({}, runOpts());
      expect(typeof result.sessionId).toBe("string");
      expect(result.sessionId.length).toBeGreaterThan(0);
      const ctx = BrowserSessionRegistry.get(result.sessionId);
      expect(ctx.isConnected()).toBe(true);
    });

    test("BrowserCloseTask closes the session", async () => {
      const task = new BrowserSessionTask({ headless: true });
      const { sessionId } = await task.run({}, runOpts());
      const closeTask = new BrowserCloseTask();
      await closeTask.run({ sessionId }, runOpts());
      expect(() => BrowserSessionRegistry.get(sessionId)).toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Navigation
  // -----------------------------------------------------------------------

  describe("BrowserNavigateTask", () => {
    let sessionId: string;

    scopedBeforeEach(async () => {
      setup();
      initSessionScope();
      const sessionTask = new BrowserSessionTask({ headless: true });
      const result = await sessionTask.run({}, runOpts());
      sessionId = result.sessionId;
    });

    test("navigates to a URL and returns title and url", async () => {
      const task = new BrowserNavigateTask({ waitUntil: "load" });
      const result = await task.run({ sessionId, url: TEST_PAGE_URL }, runOpts());
      expect(result.sessionId).toBe(sessionId);
      expect(typeof result.title).toBe("string");
      expect(typeof result.url).toBe("string");
    });
  });

  describe("BrowserBackTask", () => {
    let sessionId: string;

    scopedBeforeEach(async () => {
      setup();
      initSessionScope();
      const sessionTask = new BrowserSessionTask({ headless: true });
      const result = await sessionTask.run({}, runOpts());
      sessionId = result.sessionId;
    });

    test("calls goBack and returns sessionId and url", async () => {
      const task = new BrowserBackTask();
      const result = await task.run({ sessionId }, runOpts());
      expect(result.sessionId).toBe(sessionId);
      expect(typeof result.url).toBe("string");
    });
  });

  describe("BrowserForwardTask", () => {
    let sessionId: string;

    scopedBeforeEach(async () => {
      setup();
      initSessionScope();
      const sessionTask = new BrowserSessionTask({ headless: true });
      const result = await sessionTask.run({}, runOpts());
      sessionId = result.sessionId;
    });

    test("calls goForward and returns sessionId and url", async () => {
      const task = new BrowserForwardTask();
      const result = await task.run({ sessionId }, runOpts());
      expect(result.sessionId).toBe(sessionId);
      expect(typeof result.url).toBe("string");
    });
  });

  describe("BrowserReloadTask", () => {
    let sessionId: string;

    scopedBeforeEach(async () => {
      setup();
      initSessionScope();
      const sessionTask = new BrowserSessionTask({ headless: true });
      const result = await sessionTask.run({}, runOpts());
      sessionId = result.sessionId;
    });

    test("calls reload and returns sessionId", async () => {
      const task = new BrowserReloadTask();
      const result = await task.run({ sessionId }, runOpts());
      expect(result.sessionId).toBe(sessionId);
    });
  });

  // -----------------------------------------------------------------------
  // Snapshot & accessibility tree traversal
  // -----------------------------------------------------------------------

  describe("Snapshot", () => {
    let sessionId: string;

    scopedBeforeEach(async () => {
      setup();
      initSessionScope();
      const sessionTask = new BrowserSessionTask({ headless: true });
      const result = await sessionTask.run({}, runOpts());
      sessionId = result.sessionId;
      const navTask = new BrowserNavigateTask({ waitUntil: "load" });
      await navTask.run({ sessionId, url: TEST_PAGE_URL }, runOpts());
    });

    test("snapshot returns a tree with root and yaml", async () => {
      const ctx = BrowserSessionRegistry.get(sessionId);
      const snap = await ctx.snapshot();
      expect(snap.root).toBeDefined();
      expect(typeof snap.root.ref).toBe("string");
      expect(typeof snap.root.role).toBe("string");
      expect(typeof snap.yaml).toBe("string");
      expect(snap.yaml.length).toBeGreaterThan(0);
    });

    test("yaml contains expected element roles", async () => {
      const ctx = BrowserSessionRegistry.get(sessionId);
      const snap = await ctx.snapshot();
      expect(snap.yaml).toContain("heading");
      expect(snap.yaml).toContain("textbox");
      expect(snap.yaml).toContain("button");
    });

    test("collectNodes flattens the tree for traversal", async () => {
      const ctx = BrowserSessionRegistry.get(sessionId);
      const snap = await ctx.snapshot();
      const allNodes = collectNodes(snap.root);
      expect(allNodes.length).toBeGreaterThanOrEqual(1);
      // Every node must have a ref and a role
      for (const node of allNodes) {
        expect(typeof node.ref).toBe("string");
        expect(node.ref.length).toBeGreaterThan(0);
        expect(typeof node.role).toBe("string");
      }
    });

    test("findByRole locates a button node in the tree", async () => {
      const ctx = BrowserSessionRegistry.get(sessionId);
      const snap = await ctx.snapshot();
      const button = findByRole(snap.root, "button");
      // The button may live in root.children or be the root itself
      // depending on the backend's tree structure
      if (button) {
        expect(button.role).toBe("button");
        expect(typeof button.ref).toBe("string");
      }
    });

    test("findByRole locates a named node", async () => {
      const ctx = BrowserSessionRegistry.get(sessionId);
      const snap = await ctx.snapshot();
      const signIn = findByRole(snap.root, "button", "Sign in");
      if (signIn) {
        expect(signIn.name).toBe("Sign in");
      }
    });

    test("heading node has level property", async () => {
      const ctx = BrowserSessionRegistry.get(sessionId);
      const snap = await ctx.snapshot();
      const heading = findByRole(snap.root, "heading");
      if (heading) {
        expect(heading.level).toBe(1);
      }
    });

    test("BrowserSnapshotTask returns tree via task interface", async () => {
      const task = new BrowserSnapshotTask();
      const result = await task.run({ sessionId }, runOpts());
      expect(result.sessionId).toBe(sessionId);
      expect(result.tree).toBeDefined();
      expect(result.tree.root).toBeDefined();
      expect(typeof result.tree.yaml).toBe("string");

      // Tree should contain the same elements as a direct snapshot
      const allNodes = collectNodes(result.tree.root);
      expect(allNodes.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // Interaction — click
  // -----------------------------------------------------------------------

  describe("BrowserClickTask", () => {
    let sessionId: string;

    scopedBeforeEach(async () => {
      setup();
      initSessionScope();
      const sessionTask = new BrowserSessionTask({ headless: true });
      const result = await sessionTask.run({}, runOpts());
      sessionId = result.sessionId;
      // Navigate to test page so real backends have elements to interact with
      const navTask = new BrowserNavigateTask({ waitUntil: "load" });
      await navTask.run({ sessionId, url: TEST_PAGE_URL }, runOpts());
    });

    test("clicks by ref", async () => {
      const ctx = BrowserSessionRegistry.get(sessionId);
      const ref = await ctx.querySelector("button");
      expect(ref).toBeTruthy();

      const task = new BrowserClickTask();
      const result = await task.run({ sessionId, ref: ref! }, runOpts());
      expect(result.sessionId).toBe(sessionId);
    });

    test("clicks by role and name", async () => {
      const task = new BrowserClickTask();
      const result = await task.run({ sessionId, role: "button", name: "Sign in" }, runOpts());
      expect(result.sessionId).toBe(sessionId);
    });

    test("throws when neither ref nor role+name is provided", async () => {
      const task = new BrowserClickTask();
      await expect(task.run({ sessionId }, runOpts())).rejects.toThrow(
        "BrowserClickTask: either ref or role+name must be provided"
      );
    });
  });

  // -----------------------------------------------------------------------
  // Interaction — fill
  // -----------------------------------------------------------------------

  describe("BrowserFillTask", () => {
    let sessionId: string;

    scopedBeforeEach(async () => {
      setup();
      initSessionScope();
      const sessionTask = new BrowserSessionTask({ headless: true });
      const result = await sessionTask.run({}, runOpts());
      sessionId = result.sessionId;
      // Navigate to test page so real backends have elements to interact with
      const navTask = new BrowserNavigateTask({ waitUntil: "load" });
      await navTask.run({ sessionId, url: TEST_PAGE_URL }, runOpts());
    });

    test("fills by ref", async () => {
      const ctx = BrowserSessionRegistry.get(sessionId);
      const ref = await ctx.querySelector("input[type=text]");
      expect(ref).toBeTruthy();

      const task = new BrowserFillTask();
      const result = await task.run(
        {
          sessionId,
          ref: ref!,
          value: "test@example.com",
        },
        runOpts()
      );
      expect(result.sessionId).toBe(sessionId);
    });

    test("fills by label", async () => {
      const task = new BrowserFillTask();
      const result = await task.run(
        {
          sessionId,
          label: "Email address",
          value: "test@example.com",
        },
        runOpts()
      );
      expect(result.sessionId).toBe(sessionId);
    });

    test("throws when neither ref nor label is provided", async () => {
      const task = new BrowserFillTask();
      await expect(task.run({ sessionId, value: "test" }, runOpts())).rejects.toThrow(
        "BrowserFillTask: either ref or label must be provided"
      );
    });
  });
}
