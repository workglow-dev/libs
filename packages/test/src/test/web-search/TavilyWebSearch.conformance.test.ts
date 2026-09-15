/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { runWebSearchProviderConformance } from "@workglow/test-contract/web-search";
import { TavilyWebSearchProvider } from "@workglow/web-search";
import { httpHarness, sampleUrls } from "./harnesses";

runWebSearchProviderConformance({
  name: "TavilyWebSearchProvider",
  signalReachesTransport: false,
  fillsOpenDateBounds: false,
  createHarness: async ({ resultCount }) =>
    httpHarness({
      provider: new TavilyWebSearchProvider(),
      payload: {
        answer: "A synthesized answer.",
        results: sampleUrls(resultCount).map((url, i) => ({
          title: `Result ${i}`,
          url,
          content: "A snippet.",
          raw_content: "The whole page.",
          score: 1 - i / 100,
          published_date: "2024-03-01",
        })),
      },
    }),
});
