/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BrowserLoginTask,
  BrowserNavigateTask,
  BrowserSessionRegistry,
  BrowserUploadTask,
} from "@workglow/browser-control/task";
import type { IExecuteContext, TaskEntitlements } from "@workglow/task-graph";
import {
  createPolicyEnforcer,
  ENTITLEMENT_ENFORCER,
  Entitlements,
  TaskEntitlementError,
  TaskGraph,
  TaskGraphRunner,
  TaskInvalidInputError,
} from "@workglow/task-graph";
import { Container, ServiceRegistry } from "@workglow/util";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MockBrowserContext } from "../browser/MockBrowserContext";

// A browser is the widest reach in the repo: whatever page it opens, the extract and
// screenshot tasks hand back. So a destination is classified and declared like a fetch,
// and a local file is contained like a load.

const context = { signal: new AbortController().signal } as unknown as IExecuteContext;

function find(ents: TaskEntitlements, id: string) {
  return ents.entitlements.find((e) => e.id === id);
}

describe("browser navigation reach", () => {
  let ctx: MockBrowserContext;
  let sessionId: string;
  beforeEach(async () => {
    ctx = new MockBrowserContext();
    await ctx.connect();
    sessionId = BrowserSessionRegistry.register(ctx);
  });
  afterEach(() => BrowserSessionRegistry.clear());

  it.each([
    ["file:///etc/passwd"],
    ["data:text/html,<script>alert(1)</script>"],
    ["javascript:alert(1)"],
    ["chrome://settings"],
    // classifyUrl calls a url carrying credentials invalid, so it was declared with no
    // private scope while the browser still reached the private host behind it.
    ["http://user:pass@169.254.169.254/latest/meta-data/"],
  ])("refuses %s before the browser is asked to open it", async (url) => {
    await expect(
      new BrowserNavigateTask().execute({ sessionId, url }, context)
    ).rejects.toBeInstanceOf(TaskInvalidInputError);
    await expect(
      new BrowserLoginTask().execute({ sessionId, url } as never, context)
    ).rejects.toBeInstanceOf(TaskInvalidInputError);
    expect(ctx.calls.some((c) => c.method === "navigate")).toBe(false);
  });

  it("still opens http(s), about:blank and a relative url", async () => {
    for (const url of ["https://example.com/a", "about:blank", "/next-page"]) {
      await new BrowserNavigateTask().execute({ sessionId, url }, context);
    }
    expect(ctx.calls.filter((c) => c.method === "navigate").map((c) => c.args[0])).toEqual([
      "https://example.com/a",
      "about:blank",
      "/next-page",
    ]);
  });

  it("scopes browser:navigate to a public destination and asks nothing private of it", () => {
    const ents = new BrowserNavigateTask({
      defaults: { url: "https://example.com/x" },
    } as never).entitlements();
    expect(find(ents, Entitlements.BROWSER_CONTROL_NAVIGATE)?.resources).toEqual([
      "https://example.com/*",
    ]);
    expect(find(ents, Entitlements.NETWORK_PRIVATE)).toBeUndefined();
  });

  it("declares network:private, scoped, for a private destination", () => {
    const ents = new BrowserNavigateTask({
      defaults: { url: "http://169.254.169.254/latest/meta-data/" },
    } as never).entitlements();
    expect(find(ents, Entitlements.NETWORK_PRIVATE)?.resources).toEqual([
      "http://169.254.169.254/*",
    ]);
  });

  it("declares a url it cannot classify unscoped, as it does an unknown one", () => {
    const ents = new BrowserNavigateTask({
      defaults: { url: "http://user:pass@169.254.169.254/latest/meta-data/" },
    } as never).entitlements();
    expect(find(ents, Entitlements.NETWORK_PRIVATE)).toBeDefined();
    expect(find(ents, Entitlements.NETWORK_PRIVATE)?.resources).toBeUndefined();
  });

  it("fails closed while the destination is unknown", () => {
    const ents = new BrowserNavigateTask().entitlements();
    expect(find(ents, Entitlements.BROWSER_CONTROL_NAVIGATE)?.resources).toBeUndefined();
    expect(find(ents, Entitlements.NETWORK_PRIVATE)?.resources).toBeUndefined();
  });

  // Entitlements are declared for the url asked for; a redirect picks where the page
  // lands. Landing on a private host nothing declared is refused, as a fetch's redirect
  // hop is, and the page is cleared so a later extract cannot read it.
  function redirectTo(landing: string): void {
    const navigate = ctx.navigate.bind(ctx);
    ctx.navigate = async (url, options) => {
      await navigate(url, options);
      if (url !== "about:blank") ctx.currentPage.url = landing;
    };
  }

  it("refuses a public navigation that lands on a private host", async () => {
    redirectTo("http://169.254.169.254/latest/meta-data/");
    await expect(
      new BrowserNavigateTask().execute({ sessionId, url: "https://example.com/x" }, context)
    ).rejects.toBeInstanceOf(TaskEntitlementError);
    expect(ctx.currentPage.url).toBe("about:blank");
  });

  it("allows a private navigation that stays on its declared origin", async () => {
    redirectTo("http://10.0.0.5:8080/after");
    const out = await new BrowserNavigateTask().execute(
      { sessionId, url: "http://10.0.0.5:8080/before" },
      context
    );
    expect(out.url).toBe("http://10.0.0.5:8080/after");
  });

  it("is refused by a policy denying the private host, and never navigates", async () => {
    const registry = new ServiceRegistry(new Container());
    registry.register(ENTITLEMENT_ENFORCER, () =>
      createPolicyEnforcer({
        deny: [{ id: Entitlements.NETWORK_PRIVATE, resources: ["http://169.254.169.254/*"] }],
        grant: [
          { id: Entitlements.BROWSER_CONTROL_NAVIGATE },
          { id: Entitlements.NETWORK_PRIVATE },
        ],
        ask: [],
      })
    );
    const graph = new TaskGraph();
    graph.addTask(
      new BrowserNavigateTask({
        id: "nav",
        defaults: { sessionId, url: "http://169.254.169.254/latest/meta-data/" },
      } as never)
    );
    await expect(
      new TaskGraphRunner(graph).runGraph({}, { registry, enforceEntitlements: true })
    ).rejects.toThrow(TaskEntitlementError);
    expect(ctx.calls.some((c) => c.method === "navigate")).toBe(false);
  });
});

describe("browser upload reach", () => {
  let ctx: MockBrowserContext;
  let sessionId: string;
  let root: string;
  let inside: string;
  let outside: string;
  beforeEach(async () => {
    ctx = new MockBrowserContext();
    await ctx.connect();
    sessionId = BrowserSessionRegistry.register(ctx);
    const base = realpathSync(mkdtempSync(join(tmpdir(), "upload-reach-")));
    root = join(base, "allowed");
    mkdirSync(root);
    inside = join(root, "ok.txt");
    outside = join(base, "secret.txt");
    writeFileSync(inside, "ok");
    writeFileSync(outside, "secret");
  });
  afterEach(() => BrowserSessionRegistry.clear());

  it("uploads a file inside the configured roots", async () => {
    await new BrowserUploadTask({ roots: [root] } as never).execute(
      { sessionId, ref: "e1", filePaths: [inside] },
      context
    );
    const upload = ctx.calls.find((c) => c.method === "uploadFile");
    expect(upload?.args[1]).toEqual([inside]);
  });

  it("refuses a file outside the configured roots, uploading nothing", async () => {
    await expect(
      new BrowserUploadTask({ roots: [root] } as never).execute(
        { sessionId, ref: "e1", filePaths: [inside, outside] },
        context
      )
    ).rejects.toBeInstanceOf(TaskEntitlementError);
    expect(ctx.calls.some((c) => c.method === "uploadFile")).toBe(false);
  });

  // A grant names files; what is uploaded is the file a path resolves to. A grant for
  // a symlink must not cover the file behind it.
  it("declares the file a symlink resolves to, not the link", () => {
    const link = join(root, "link.txt");
    symlinkSync(outside, link);
    const ents = new BrowserUploadTask({ defaults: { filePaths: [link] } } as never).entitlements();
    expect(find(ents, Entitlements.FILESYSTEM_READ)?.resources).toEqual([outside]);
  });

  it("accepts a file under a filesystem root configured as the root", async () => {
    await new BrowserUploadTask({ roots: ["/"] } as never).execute(
      { sessionId, ref: "e1", filePaths: [inside] },
      context
    );
    expect(ctx.calls.find((c) => c.method === "uploadFile")?.args[1]).toEqual([inside]);
  });

  it("declares filesystem:read scoped to the paths it was given", () => {
    const ents = new BrowserUploadTask({
      defaults: { filePaths: [inside] },
    } as never).entitlements();
    expect(find(ents, Entitlements.FILESYSTEM_READ)?.resources).toEqual([inside]);
  });
});
