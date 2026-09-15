/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { GeminiWebSearchProvider } from "@workglow/google-gemini/web-search";
import { runWebSearchProviderConformance } from "@workglow/test-contract/web-search";
import { sampleUrls, sdkHarness } from "./harnesses";

runWebSearchProviderConformance({
  name: "GeminiWebSearchProvider",
  signalReachesTransport: true,
  createHarness: async ({ resultCount }) => {
    const sent: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const client = {
      models: {
        generateContent: async (body: { config?: { abortSignal?: AbortSignal } }) => {
          sent.push(
            JSON.stringify(body, (key, value) => (key === "abortSignal" ? undefined : value))
          );
          signals.push(body.config?.abortSignal);
          return {
            text: "A synthesized answer.",
            usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22 },
            candidates: [
              {
                groundingMetadata: {
                  groundingChunks: sampleUrls(resultCount).map((uri, i) => ({
                    web: { uri, title: `Result ${i}`, domain: "example.com" },
                  })),
                },
              },
            ],
          };
        },
      },
    };

    return sdkHarness({
      provider: new GeminiWebSearchProvider({ client: client as never }),
      sent,
      signals,
    });
  },
});
