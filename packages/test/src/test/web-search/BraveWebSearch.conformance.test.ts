/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { runWebSearchProviderConformance } from "@workglow/test-contract/web-search";
import { BraveWebSearchProvider } from "@workglow/web-search";
import { httpHarness, sampleUrls } from "./harnesses";

runWebSearchProviderConformance({
  name: "BraveWebSearchProvider",
  signalReachesTransport: false,
  fillsOpenDateBounds: true,
  createHarness: async ({ resultCount }) =>
    httpHarness({
      provider: new BraveWebSearchProvider(),
      payload: {
        web: {
          results: sampleUrls(resultCount).map((url, i) => ({
            title: `Result ${i}`,
            url,
            description: "A description.",
            page_age: "2024-03-01T00:00:00Z",
          })),
        },
      },
    }),
});
