/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { AnthropicWebSearchProvider } from "@workglow/anthropic/web-search";
import { runWebSearchProviderConformance } from "@workglow/test-contract/web-search";
import { sampleUrls, sdkHarness } from "./harnesses";

runWebSearchProviderConformance({
  name: "AnthropicWebSearchProvider",
  signalReachesTransport: true,
  createHarness: async ({ resultCount }) => {
    const sent: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const client = {
      messages: {
        create: async (body: unknown, options?: { signal?: AbortSignal }) => {
          sent.push(JSON.stringify(body));
          signals.push(options?.signal);
          return {
            stop_reason: "end_turn",
            usage: { input_tokens: 11, output_tokens: 22 },
            content: [
              { type: "text", text: "A synthesized answer." },
              {
                type: "web_search_tool_result",
                content: sampleUrls(resultCount).map((url, i) => ({
                  type: "web_search_result",
                  title: `Result ${i}`,
                  url,
                  page_age: "March 1, 2024",
                })),
              },
            ],
          };
        },
      },
    };

    return sdkHarness({
      provider: new AnthropicWebSearchProvider({ client: client as never }),
      sent,
      signals,
    });
  },
});
