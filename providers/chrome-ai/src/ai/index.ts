/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

// organize-imports-ignore

export { queryWebBrowserModelStatus } from "./common/WebBrowser_ChromeHelpers";
export * from "./common/WebBrowser_Constants";
export * from "./common/WebBrowser_ModelSchema";
export * from "./registerWebBrowser";

import {
  inferWebBrowserCapabilities,
  WEB_BROWSER_RUN_FN_SPECS,
} from "./common/WebBrowser_Capabilities";
import { _resetProbeCache, probeWebBrowserCapabilities } from "./common/WebBrowser_CapabilityProbe";
import { WebBrowser_Chat } from "./common/WebBrowser_Chat";
import {
  buildInitialPromptsFromHistory,
  findLastUserIndex,
  flattenToolExchange,
  messageText,
} from "./common/WebBrowser_ChatHistory";
import { snapshotStreamToTextDeltas } from "./common/WebBrowser_ChromeHelpers";
import {
  WEB_BROWSER_RUN_FNS,
  WebBrowser_TextGeneration_Unified,
} from "./common/WebBrowser_JobRunFns";
import {
  deleteChromeSession,
  disposeWebBrowserSession,
  disposeWebBrowserSessionsForModel,
  dropChromeSessionEntry,
  getChromeSession,
  getWebBrowserModelKey,
  getWebBrowserSession,
  resetWebBrowserSessionsForTests,
  setChromeSession,
  setWebBrowserSession,
  touchWebBrowserSession,
  WEB_BROWSER_SESSION_IDLE_MS,
} from "./common/WebBrowser_Sessions";
import { WebBrowser_StructuredGeneration } from "./common/WebBrowser_StructuredGeneration";
import { WebBrowser_ToolCalling } from "./common/WebBrowser_ToolCalling";
import { WebBrowserProvider } from "./WebBrowserProvider";

/**
 * @internal Symbols exported only for use by `@workglow/test`. Not part of the stable public API.
 */
export const _testOnly = {
  WebBrowserProvider,
  WEB_BROWSER_RUN_FN_SPECS,
  WEB_BROWSER_RUN_FNS,
  inferWebBrowserCapabilities,
  WebBrowser_Chat,
  WebBrowser_TextGeneration_Unified,
  WebBrowser_StructuredGeneration,
  WebBrowser_ToolCalling,
  // chat-session cache (per-turn reuse for AiChatTask / StructuredGen / ToolCalling)
  sessions: {
    getChromeSession,
    setChromeSession,
    deleteChromeSession,
    dropChromeSessionEntry,
  },
  chatHistory: {
    messageText,
    findLastUserIndex,
    buildInitialPromptsFromHistory,
    flattenToolExchange,
  },
  chromeHelpers: {
    snapshotStreamToTextDeltas,
  },
  probe: {
    probeWebBrowserCapabilities,
    _resetProbeCache,
  },
  // idle-evict session store (model-level lifecycle, used by ModelDispose)
  WEB_BROWSER_SESSION_IDLE_MS,
  disposeWebBrowserSession,
  disposeWebBrowserSessionsForModel,
  getWebBrowserModelKey,
  getWebBrowserSession,
  resetWebBrowserSessionsForTests,
  setWebBrowserSession,
  touchWebBrowserSession,
} as const;
