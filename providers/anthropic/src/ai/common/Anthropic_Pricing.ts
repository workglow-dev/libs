/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelPricing } from "@workglow/ai";
import { resolveModelPricingFromTable } from "@workglow/ai";

/**
 * Public list pricing for Anthropic Claude models (USD per 1M tokens).
 *
 * No card carries a long-context tier, and that is not an omission: the
 * 1M-context models (Opus 4.6 and later, Sonnet 4.6 and later, Fable) bill a
 * long prompt at these same rates, and every other model here has a 200K
 * window, so no prompt size could select one.
 */
export const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  "claude-fable-5-1": {
    currency: "USD",
    input: 10,
    output: 50,
    cached: 0.25,
    cacheWrite: {
      cacheWrite5m: 12.5,
      cacheWrite1h: 20,
    },
    batch: {
      input: 5,
      output: 25,
      cached: 0.125,
      cacheWrite: {
        cacheWrite5m: 6.25,
        cacheWrite1h: 10,
      },
    },
  },
  "claude-fable-5": {
    currency: "USD",
    input: 10,
    output: 50,
    cached: 0.25,
    cacheWrite: {
      cacheWrite5m: 12.5,
      cacheWrite1h: 20,
    },
    batch: {
      input: 5,
      output: 25,
      cached: 0.125,
      cacheWrite: {
        cacheWrite5m: 6.25,
        cacheWrite1h: 10,
      },
    },
  },
  "claude-opus-5-5": {
    currency: "USD",
    input: 4,
    output: 20,
    cached: 0.2,
    cacheWrite: {
      cacheWrite5m: 5,
      cacheWrite1h: 8,
    },
    batch: {
      input: 2,
      output: 10,
      cached: 0.1,
      cacheWrite: {
        cacheWrite5m: 2.5,
        cacheWrite1h: 4,
      },
    },
  },
  "claude-sonnet-5-5": {
    currency: "USD",
    input: 2,
    output: 10,
    cached: 0.2,
    cacheWrite: {
      cacheWrite5m: 2.5,
      cacheWrite1h: 4,
    },
    batch: {
      input: 1,
      output: 5,
      cached: 0.1,
      cacheWrite: {
        cacheWrite5m: 1.25,
        cacheWrite1h: 2,
      },
    },
  },
  "claude-opus-5": {
    currency: "USD",
    input: 5,
    output: 25,
    cached: 0.5,
    cacheWrite: {
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
    },
    batch: {
      input: 2.5,
      output: 12.5,
      cached: 0.25,
      cacheWrite: {
        cacheWrite5m: 3.125,
        cacheWrite1h: 5,
      },
    },
  },
  "claude-sonnet-5": {
    currency: "USD",
    input: 2,
    output: 10,
    cached: 0.2,
    cacheWrite: {
      cacheWrite5m: 2.5,
      cacheWrite1h: 4,
    },
    batch: {
      input: 1,
      output: 5,
      cached: 0.1,
      cacheWrite: {
        cacheWrite5m: 1.25,
        cacheWrite1h: 2,
      },
    },
  },
  "claude-opus-4-8": {
    currency: "USD",
    input: 5,
    output: 25,
    cached: 0.5,
    cacheWrite: {
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
    },
    batch: {
      input: 2.5,
      output: 12.5,
      cached: 0.25,
      cacheWrite: {
        cacheWrite5m: 3.125,
        cacheWrite1h: 5,
      },
    },
  },
  "claude-opus-4-7": {
    currency: "USD",
    input: 5,
    output: 25,
    cached: 0.5,
    cacheWrite: {
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
    },
    batch: {
      input: 2.5,
      output: 12.5,
      cached: 0.25,
      cacheWrite: {
        cacheWrite5m: 3.125,
        cacheWrite1h: 5,
      },
    },
  },
  "claude-haiku-4-5": {
    currency: "USD",
    input: 1,
    output: 5,
    cached: 0.1,
    cacheWrite: {
      cacheWrite5m: 1.25,
      cacheWrite1h: 2,
    },
    batch: {
      input: 0.5,
      output: 2.5,
      cached: 0.05,
      cacheWrite: {
        cacheWrite5m: 0.625,
        cacheWrite1h: 1,
      },
    },
  },
  "claude-sonnet-4-6": {
    currency: "USD",
    input: 3,
    output: 15,
    cached: 0.3,
    cacheWrite: {
      cacheWrite5m: 3.75,
      cacheWrite1h: 6,
    },
    batch: {
      input: 1.5,
      output: 7.5,
      cached: 0.15,
      cacheWrite: {
        cacheWrite5m: 1.875,
        cacheWrite1h: 3,
      },
    },
  },
  "claude-opus-4-6": {
    currency: "USD",
    input: 5,
    output: 25,
    cached: 0.5,
    cacheWrite: {
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
    },
    batch: {
      input: 2.5,
      output: 12.5,
      cached: 0.25,
      cacheWrite: {
        cacheWrite5m: 3.125,
        cacheWrite1h: 5,
      },
    },
  },
  "claude-sonnet-4-5-20250929": {
    currency: "USD",
    input: 3,
    output: 15,
    cached: 0.3,
    cacheWrite: {
      cacheWrite5m: 3.75,
      cacheWrite1h: 6,
    },
    batch: {
      input: 1.5,
      output: 7.5,
      cached: 0.15,
      cacheWrite: {
        cacheWrite5m: 1.875,
        cacheWrite1h: 3,
      },
    },
  },
  "claude-sonnet-4-5": {
    currency: "USD",
    input: 3,
    output: 15,
    cached: 0.3,
    cacheWrite: {
      cacheWrite5m: 3.75,
      cacheWrite1h: 6,
    },
    batch: {
      input: 1.5,
      output: 7.5,
      cached: 0.15,
      cacheWrite: {
        cacheWrite5m: 1.875,
        cacheWrite1h: 3,
      },
    },
  },
  "claude-3-7-sonnet": {
    currency: "USD",
    input: 3,
    output: 15,
    cached: 0.3,
    cacheWrite: {
      cacheWrite5m: 3.75,
      cacheWrite1h: 6,
    },
  },
  "claude-3-5-sonnet": {
    currency: "USD",
    input: 3,
    output: 15,
    cached: 0.3,
    cacheWrite: {
      cacheWrite5m: 3.75,
      cacheWrite1h: 6,
    },
  },
  "claude-3-5-haiku": {
    currency: "USD",
    input: 0.8,
    output: 4,
    cached: 0.08,
    cacheWrite: {
      cacheWrite5m: 1,
      cacheWrite1h: 1.6,
    },
  },
  "claude-3-haiku": {
    currency: "USD",
    input: 0.25,
    output: 1.25,
    cached: 0.025,
    cacheWrite: {
      cacheWrite5m: 0.3125,
      cacheWrite1h: 0.5,
    },
  },
  "claude-3-opus": {
    currency: "USD",
    input: 15,
    output: 75,
    cached: 1.5,
    cacheWrite: {
      cacheWrite5m: 18.75,
      cacheWrite1h: 30,
    },
  },
};

/**
 * Resolve list pricing for an Anthropic Claude model id.
 */
export function getAnthropicModelPricing(modelId: string | undefined): ModelPricing | undefined {
  return resolveModelPricingFromTable(ANTHROPIC_PRICING, modelId, ["anthropic/"]);
}
