/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { OpenAiWebSearchProvider } from "@workglow/openai/web-search";
import { runWebSearchProviderConformance } from "@workglow/test-contract/web-search";
import { sampleUrls, sdkHarness } from "./harnesses";

runWebSearchProviderConformance({
  name: "OpenAiWebSearchProvider",
  signalReachesTransport: true,
  createHarness: async ({ resultCount }) => {
    const sent: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const client = {
      responses: {
        create: async (body: unknown, options?: { signal?: AbortSignal }) => {
          sent.push(JSON.stringify(body));
          signals.push(options?.signal);
          return {
            usage: { input_tokens: 11, output_tokens: 22 },
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "A synthesized answer.",
                    annotations: sampleUrls(resultCount).map((url, i) => ({
                      type: "url_citation",
                      title: `Result ${i}`,
                      url,
                    })),
                  },
                ],
              },
            ],
          };
        },
      },
    };

    return sdkHarness({
      provider: new OpenAiWebSearchProvider({ client: client as never }),
      sent,
      signals,
    });
  },
});
