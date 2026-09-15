/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AccessibilityNode,
  AccessibilityTree,
  AriaRole,
  BrowserConnectOptions,
  ClickOptions,
  ConsoleMessage,
  DialogAction,
  DialogInfo,
  DownloadOptions,
  DownloadResult,
  ElementRef,
  IBrowserContext,
  NavigateOptions,
  NetworkRequest,
  ScreenshotOptions,
  SnapshotOptions,
  TabInfo,
  WaitOptions,
} from "@workglow/browser-control/task";

interface PageState {
  readonly tabId: string;
  url: string;
  title: string;
  ariaButtons: ReadonlyArray<{ readonly idx: number; readonly name: string }>;
  sentinelClicked: string;
  network: NetworkRequest[];
  console: ConsoleMessage[];
}

/**
 * Parses the conformance fixture page out of a `data:text/html,...` URL by
 * scraping aria-label values from `<button ... aria-label="...">` tags. This
 * is intentionally narrow — only the conformance fixture page is supported.
 */
function parseFixturePage(url: string): {
  readonly title: string;
  readonly ariaButtons: ReadonlyArray<{ readonly idx: number; readonly name: string }>;
  readonly networkMarker: string | undefined;
  readonly consoleMarker: string | undefined;
} {
  let html = "";
  if (url.startsWith("data:text/html,")) {
    html = decodeURIComponent(url.slice("data:text/html,".length));
  }
  const titleMatch = /<title>([^<]*)<\/title>/.exec(html);
  const buttons: { idx: number; name: string }[] = [];
  const buttonRe = /<button[^>]*aria-label="([^"]*)"[^>]*>/g;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = buttonRe.exec(html)) !== null) {
    const decoded = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    buttons.push({ idx, name: decoded });
    idx++;
  }
  const fetchMatch = /fetch\("data:text\/plain,([^"]+)"/.exec(html);
  const consoleMatch = /console\.log\("([^"]+)"\)/.exec(html);
  return {
    title: titleMatch ? titleMatch[1] : "",
    ariaButtons: buttons,
    networkMarker: fetchMatch?.[1],
    consoleMarker: consoleMatch?.[1],
  };
}

export class ConformanceMockContext implements IBrowserContext {
  private connected = false;
  private nextTabSeq = 1;
  private nextRefSeq = 1;
  private pages: PageState[] = [];
  private activeTabId: string | undefined;
  /** ref → { tabId, name } produced by snapshot(). */
  private refMap = new Map<string, { tabId: string; name: string; idx: number }>();

  // networkRequests / consoleMessages are intentionally absent (undefined)
  // when the corresponding capability flag is false. The shim wires this
  // class with capabilities.{networkRequests,consoleMessages}: false, so
  // these properties stay undefined to satisfy capability honesty (negative).

  // -- Lifecycle ------------------------------------------------------------
  async connect(_options?: BrowserConnectOptions): Promise<void> {
    this.connected = true;
    if (this.pages.length === 0) {
      const page = this.makePage("about:blank", "");
      this.pages.push(page);
      this.activeTabId = page.tabId;
    }
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.pages = [];
    this.activeTabId = undefined;
    this.refMap.clear();
  }
  isConnected(): boolean {
    return this.connected;
  }

  private makePage(url: string, title: string): PageState {
    return {
      tabId: `mock-tab-${this.nextTabSeq++}`,
      url,
      title,
      ariaButtons: [],
      sentinelClicked: "",
      network: [],
      console: [],
    };
  }

  private active(): PageState {
    const p = this.pages.find((p) => p.tabId === this.activeTabId);
    if (!p) throw new Error("ConformanceMockContext: no active tab");
    return p;
  }

  // -- Navigation -----------------------------------------------------------
  async navigate(url: string, _options?: NavigateOptions): Promise<void> {
    const page = this.active();
    page.url = url;
    const parsed = parseFixturePage(url);
    page.title = parsed.title;
    page.ariaButtons = parsed.ariaButtons;
    page.sentinelClicked = "";
    if (parsed.networkMarker) {
      page.network.push({
        url: `data:text/plain,${parsed.networkMarker}`,
        method: "GET",
        status: 200,
        headers: {},
      });
    }
    if (parsed.consoleMarker) {
      page.console.push({ type: "log", text: parsed.consoleMarker });
    }
  }
  async goBack(_options?: NavigateOptions): Promise<void> {}
  async goForward(_options?: NavigateOptions): Promise<void> {}
  async reload(_options?: NavigateOptions): Promise<void> {}
  async currentUrl(): Promise<string> {
    return this.active().url;
  }
  async title(): Promise<string> {
    return this.active().title;
  }

  // -- Accessibility --------------------------------------------------------
  async snapshot(_options?: SnapshotOptions): Promise<AccessibilityTree> {
    const page = this.active();
    const children: AccessibilityNode[] = page.ariaButtons.map((b) => {
      const ref: ElementRef = `e${this.nextRefSeq++}`;
      this.refMap.set(ref, { tabId: page.tabId, name: b.name, idx: b.idx });
      return { ref, role: "button", name: b.name };
    });
    const rootRef: ElementRef = `e${this.nextRefSeq++}`;
    return {
      root: { ref: rootRef, role: "document", name: page.title, children },
      yaml: children.map((c) => `- button [${c.ref}]: ${c.name}`).join("\n"),
    };
  }

  // -- Element interaction --------------------------------------------------
  async click(ref: ElementRef, _options?: ClickOptions): Promise<void> {
    const entry = this.refMap.get(ref);
    if (!entry) throw new Error(`ConformanceMockContext: unknown ref "${ref}"`);
    const page = this.pages.find((p) => p.tabId === entry.tabId);
    if (!page) throw new Error(`ConformanceMockContext: tab gone for ref "${ref}"`);
    page.sentinelClicked = String(entry.idx);
  }
  async fill(_ref: ElementRef, _value: string, _options?: WaitOptions): Promise<void> {}
  async selectOption(
    _ref: ElementRef,
    _values: string | readonly string[],
    _options?: WaitOptions
  ): Promise<void> {}
  async hover(_ref: ElementRef, _options?: WaitOptions): Promise<void> {}

  async clickByRole(role: AriaRole, name: string, _options?: ClickOptions): Promise<void> {
    if (role !== "button") {
      throw new Error(`ConformanceMockContext: unsupported role "${role}"`);
    }
    const page = this.active();
    const btn = page.ariaButtons.find((b) => b.name === name);
    if (!btn) throw new Error(`ConformanceMockContext: no button named ${JSON.stringify(name)}`);
    page.sentinelClicked = String(btn.idx);
  }
  async fillByLabel(_label: string, _value: string, _options?: WaitOptions): Promise<void> {}

  // -- Content extraction ---------------------------------------------------
  async content(): Promise<string> {
    return "";
  }
  async innerHTML(_ref: ElementRef): Promise<string> {
    return "";
  }
  async textContent(ref: ElementRef): Promise<string | null> {
    const entry = this.refMap.get(ref);
    return entry ? entry.name : null;
  }
  async attribute(ref: ElementRef, name: string): Promise<string | null> {
    // Only the synthetic sentinel ref carries data-clicked. Button refs and
    // other refs do not have per-element attributes modeled — they get null,
    // matching what a real backend would return for an unrelated attribute.
    if (name === "data-clicked" && ref.startsWith("sentinel-")) {
      const tabId = ref.slice("sentinel-".length);
      const page = this.pages.find((p) => p.tabId === tabId);
      return page ? page.sentinelClicked : null;
    }
    return null;
  }
  async querySelector(selector: string): Promise<ElementRef | null> {
    if (selector === "#sentinel") {
      // Return a stable sentinel ref scoped to the active tab so that
      // attribute() can resolve the page's sentinelClicked value.
      const page = this.active();
      return `sentinel-${page.tabId}` as ElementRef;
    }
    return null;
  }
  async querySelectorAll(_selector: string): Promise<readonly ElementRef[]> {
    return [];
  }

  async evaluate<T>(expression: string): Promise<T> {
    // Narrow support: the assertion suite reads sentinel via attribute(), not
    // evaluate(), but provide a readiness check used by waitForIdle.
    if (expression.includes("readyState")) return true as unknown as T;
    return undefined as unknown as T;
  }

  async screenshot(_options?: ScreenshotOptions): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async pressKey(_key: string, _options?: WaitOptions): Promise<void> {}
  async type(_text: string, _options?: WaitOptions): Promise<void> {}
  async scroll(_x: number, _y: number, _ref?: ElementRef): Promise<void> {}
  async uploadFile(_ref: ElementRef, _paths: string | readonly string[]): Promise<void> {}
  async download(
    trigger: () => Promise<void>,
    _options?: DownloadOptions
  ): Promise<DownloadResult> {
    await trigger();
    return { path: "", suggestedFilename: "" };
  }
  onDialog(_handler: (info: DialogInfo) => DialogAction | Promise<DialogAction>): void {}

  // -- Tabs -----------------------------------------------------------------
  async tabs(): Promise<readonly TabInfo[]> {
    return this.pages.map((p) => ({ tabId: p.tabId, url: p.url, title: p.title }));
  }
  async switchTab(tabId: string): Promise<void> {
    if (!this.pages.some((p) => p.tabId === tabId)) {
      throw new Error(`ConformanceMockContext: no tab "${tabId}"`);
    }
    this.activeTabId = tabId;
  }
  async newTab(url?: string): Promise<TabInfo> {
    const page = this.makePage(url ?? "about:blank", "");
    this.pages.push(page);
    if (url) {
      const prev = this.activeTabId;
      this.activeTabId = page.tabId;
      await this.navigate(url);
      this.activeTabId = prev;
    }
    return { tabId: page.tabId, url: page.url, title: page.title };
  }
  async closeTab(tabId: string): Promise<void> {
    const before = this.pages.length;
    this.pages = this.pages.filter((p) => p.tabId !== tabId);
    if (this.pages.length === before) {
      throw new Error(`ConformanceMockContext: no tab "${tabId}"`);
    }
    if (this.activeTabId === tabId) {
      this.activeTabId = this.pages[this.pages.length - 1]?.tabId;
    }
  }

  // -- Wait -----------------------------------------------------------------
  async waitForNavigation(_options?: NavigateOptions): Promise<void> {}
  async waitForSelector(_selector: string, _options?: WaitOptions): Promise<ElementRef> {
    return "e0";
  }
  async waitForIdle(_options?: WaitOptions): Promise<void> {}
}
