/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { runWebSearchProviderConformance } from "@workglow/test-contract/web-search";
import { SearxngWebSearchProvider } from "@workglow/web-search";
import { httpHarness, sampleUrls } from "./harnesses";

// The live instance keeps its own `.integration.test.ts`, which is the only
// unmocked provider test in the tree because SearXNG is the only one with no
// key and no quota. This is the mocked half — the contract, not the instance.
runWebSearchProviderConformance({
  name: "SearxngWebSearchProvider",
  signalReachesTransport: false,
  fillsOpenDateBounds: false,
  createHarness: async ({ resultCount }) =>
    httpHarness({
      provider: new SearxngWebSearchProvider("https://searxng.example"),
      payload: {
        results: sampleUrls(resultCount).map((url, i) => ({
          title: `Result ${i}`,
          url,
          content: "A snippet.",
          publishedDate: "2024-03-01T00:00:00Z",
        })),
      },
    }),
});
