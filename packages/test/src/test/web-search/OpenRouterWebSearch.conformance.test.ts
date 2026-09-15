/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { OpenRouterWebSearchProvider } from "@workglow/openrouter/web-search";
import { runWebSearchProviderConformance } from "@workglow/test-contract/web-search";
import { sampleUrls, sdkHarness } from "./harnesses";

runWebSearchProviderConformance({
  name: "OpenRouterWebSearchProvider",
  signalReachesTransport: true,
  createHarness: async ({ resultCount }) => {
    const sent: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const client = {
      chat: {
        completions: {
          create: async (body: unknown, options?: { signal?: AbortSignal }) => {
            sent.push(JSON.stringify(body));
            signals.push(options?.signal);
            return {
              usage: { prompt_tokens: 11, completion_tokens: 22 },
              choices: [
                {
                  message: {
                    content: "A synthesized answer.",
                    annotations: sampleUrls(resultCount).map((url, i) => ({
                      type: "url_citation",
                      url_citation: { title: `Result ${i}`, url, content: "A snippet." },
                    })),
                  },
                },
              ],
            };
          },
        },
      },
    };

    return sdkHarness({
      provider: new OpenRouterWebSearchProvider({ client: client as never }),
      sent,
      signals,
    });
  },
});
