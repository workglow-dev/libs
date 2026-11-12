/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BrowserAttributeTask,
  BrowserEvaluateTask,
  BrowserExtractHtmlTask,
  BrowserExtractTextTask,
  BrowserLoginTask,
  BrowserNavigateTask,
  BrowserNewTabTask,
  BrowserScreenshotTask,
  BrowserSessionRegistry,
  BrowserSnapshotTask,
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
import dns from "node:dns";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockBrowserContext } from "../browser/MockBrowserContext";

// A browser is the widest reach in the repo: whatever page it opens, the extract and
// screenshot tasks hand back. So a destination is classified and declared like a fetch,
// and a local file is contained like a load.

const context = { signal: new AbortController().signal } as unknown as IExecuteContext;

function find(ents: TaskEntitlements, id: string) {
  return ents.entitlements.find((e) => e.id === id);
}

// DNS is mocked: these names answer with a private address, everything else with a
// public one, and nothing reaches the network.
const PRIVATE_ANSWERS: Record<string, string> = {
  "169.254.169.254.nip.io": "169.254.169.254",
  "rebind.example.com": "10.0.0.7",
  "mixed.example.com": "127.0.0.1",
};

let lookup: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  lookup = vi.spyOn(dns.promises, "lookup");
  lookup.mockImplementation((async (host: string) => {
    if (host === "mixed.example.com") {
      return [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ];
    }
    const priv = PRIVATE_ANSWERS[host];
    return [{ address: priv ?? "93.184.216.34", family: 4 }];
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

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

  // A failed reset must not replace the refusal: the caller needs to read why.
  it("reports the refusal even when clearing the page fails", async () => {
    redirectTo("http://169.254.169.254/latest/meta-data/");
    const navigate = ctx.navigate.bind(ctx);
    ctx.navigate = async (url, options) => {
      if (url === "about:blank") throw new Error("page crashed");
      await navigate(url, options);
    };
    await expect(
      new BrowserNavigateTask().execute({ sessionId, url: "https://example.com/x" }, context)
    ).rejects.toBeInstanceOf(TaskEntitlementError);
  });

  // classifyUrl reads only the name; a public-looking name answering with a private
  // address is refused as safeFetch refuses it, with or without network:private.
  it.each([
    ["http://169.254.169.254.nip.io/latest/meta-data/"],
    ["https://rebind.example.com/"],
    ["https://mixed.example.com/"],
  ])("refuses %s, a public name resolving to a private address", async (url) => {
    await expect(
      new BrowserNavigateTask().execute({ sessionId, url }, context)
    ).rejects.toBeInstanceOf(TaskEntitlementError);
    await expect(
      new BrowserNewTabTask().execute({ sessionId, url }, context)
    ).rejects.toBeInstanceOf(TaskEntitlementError);
    expect(ctx.calls.some((c) => c.method === "navigate" || c.method === "newTab")).toBe(false);
  });

  it("refuses a public navigation redirected to a name resolving privately", async () => {
    redirectTo("http://169.254.169.254.nip.io/latest/meta-data/");
    await expect(
      new BrowserNavigateTask().execute({ sessionId, url: "https://example.com/x" }, context)
    ).rejects.toBeInstanceOf(TaskEntitlementError);
    expect(ctx.currentPage.url).toBe("about:blank");
  });

  it("refuses when the name cannot be resolved", async () => {
    lookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(
      new BrowserNavigateTask().execute({ sessionId, url: "https://gone.example.com/" }, context)
    ).rejects.toBeInstanceOf(TaskEntitlementError);
  });

  // An empty answer proves nothing about where the browser's own lookup will land.
  it("refuses when the name resolves to no address", async () => {
    lookup.mockResolvedValueOnce([] as never);
    await expect(
      new BrowserNavigateTask().execute({ sessionId, url: "https://empty.example.com/" }, context)
    ).rejects.toBeInstanceOf(TaskEntitlementError);
  });

  // A page can move after its navigation was checked: a meta refresh, a script setting
  // location, a click. Every task that hands the page back checks where it is first.
  describe("a page that moved after it loaded", () => {
    const readers: readonly [string, () => Promise<unknown>][] = [
      ["text", () => new BrowserExtractTextTask().execute({ sessionId }, context)],
      [
        "html",
        () =>
          new BrowserExtractHtmlTask({ selector: "body" } as never).execute({ sessionId }, context),
      ],
      ["screenshot", () => new BrowserScreenshotTask().execute({ sessionId }, context)],
      ["snapshot", () => new BrowserSnapshotTask().execute({ sessionId }, context)],
      [
        "attribute",
        () =>
          new BrowserAttributeTask().execute(
            { sessionId, ref: "e1", attribute: "href" } as never,
            context
          ),
      ],
      [
        "evaluate",
        () =>
          new BrowserEvaluateTask().execute({ sessionId, expression: "document.title" }, context),
      ],
    ];

    it.each(readers)("%s refuses a private host no navigation declared", async (_name, read) => {
      await new BrowserNavigateTask().execute({ sessionId, url: "https://example.com/x" }, context);
      ctx.currentPage.url = "http://169.254.169.254/latest/meta-data/";
      await expect(read()).rejects.toBeInstanceOf(TaskEntitlementError);
    });

    it.each(readers)("%s refuses a public name resolving privately", async (_name, read) => {
      await new BrowserNavigateTask().execute({ sessionId, url: "https://example.com/x" }, context);
      ctx.currentPage.url = "https://rebind.example.com/";
      await expect(read()).rejects.toBeInstanceOf(TaskEntitlementError);
    });

    it("refuses a page that moves while it is being read", async () => {
      await new BrowserNavigateTask().execute({ sessionId, url: "https://example.com/x" }, context);
      ctx.textContent = async () => {
        ctx.currentPage.url = "http://10.0.0.9/";
        return "secret";
      };
      await expect(
        new BrowserExtractTextTask().execute({ sessionId }, context)
      ).rejects.toBeInstanceOf(TaskEntitlementError);
    });

    it("reads a public page, and a private one a navigation declared", async () => {
      await new BrowserNavigateTask().execute(
        { sessionId, url: "https://public.example.test/x" },
        context
      );
      await expect(
        new BrowserExtractTextTask().execute({ sessionId }, context)
      ).resolves.toBeDefined();
      await new BrowserNavigateTask().execute(
        { sessionId, url: "http://10.0.0.5:8080/before" },
        context
      );
      ctx.currentPage.url = "http://10.0.0.5:8080/elsewhere";
      await expect(
        new BrowserExtractTextTask().execute({ sessionId }, context)
      ).resolves.toBeDefined();
      // Declaring one private origin does not admit another.
      ctx.currentPage.url = "http://10.0.0.6:8080/";
      await expect(
        new BrowserExtractTextTask().execute({ sessionId }, context)
      ).rejects.toBeInstanceOf(TaskEntitlementError);
    });
  });

  // A new tab given a url navigates as surely as BrowserNavigateTask does.
  describe("a new tab", () => {
    it.each([["file:///etc/passwd"], ["data:text/html,<b>x</b>"], ["javascript:alert(1)"]])(
      "refuses %s before opening a tab",
      async (url) => {
        await expect(
          new BrowserNewTabTask().execute({ sessionId, url }, context)
        ).rejects.toBeInstanceOf(TaskInvalidInputError);
        expect(ctx.calls.some((c) => c.method === "newTab")).toBe(false);
      }
    );

    it("closes a tab that landed on a private host it did not declare", async () => {
      ctx.newTab = async (url) => {
        ctx.calls.push({ method: "newTab", args: [url] } as never);
        return { tabId: "tab-2", url: "http://169.254.169.254/latest/meta-data/", title: "" };
      };
      await expect(
        new BrowserNewTabTask().execute({ sessionId, url: "https://example.com/x" }, context)
      ).rejects.toBeInstanceOf(TaskEntitlementError);
      expect(ctx.calls.find((c) => c.method === "closeTab")?.args[0]).toBe("tab-2");
    });

    it("declares browser:navigate scoped to its url, and nothing for a blank tab", () => {
      const ents = new BrowserNewTabTask({
        defaults: { url: "http://10.0.0.5/x" },
      } as never).entitlements();
      expect(find(ents, Entitlements.BROWSER_CONTROL_NAVIGATE)?.resources).toEqual([
        "http://10.0.0.5/*",
      ]);
      expect(find(ents, Entitlements.NETWORK_PRIVATE)?.resources).toEqual(["http://10.0.0.5/*"]);
      expect(new BrowserNewTabTask().entitlements().entitlements).toEqual([]);
    });

    // The class answer is read before any input is known, so it names the family a
    // url could need — never narrower than an instance.
    it("declares navigation on the class", () => {
      expect(BrowserNewTabTask.hasDynamicEntitlements).toBe(true);
      expect(
        find(BrowserNewTabTask.entitlements(), Entitlements.BROWSER_CONTROL_NAVIGATE)
      ).toBeDefined();
    });

    it("opens a blank tab and an http(s) one", async () => {
      await new BrowserNewTabTask().execute({ sessionId }, context);
      await new BrowserNewTabTask().execute({ sessionId, url: "https://example.com/a" }, context);
      expect(ctx.calls.filter((c) => c.method === "newTab").map((c) => c.args[0])).toEqual([
        undefined,
        "https://example.com/a",
      ]);
    });
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
