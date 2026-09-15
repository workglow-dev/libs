/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { classifyProviderError } from "@workglow/ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  creditExhaustionSkipsTest,
  isCreditExhaustedError,
  runWithCreditSkip,
  wrapTestBodyForCreditSkip,
} from "@workglow/test-contract/credit-exhausted-skip";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("isCreditExhaustedError", () => {
  it("recognizes HuggingFace Inference 402 included-credits exhaustion", () => {
    const err = Object.assign(
      new Error(
        "You have exceeded your monthly included credits for Inference Providers. Subscribe to PRO to get 20x more usage."
      ),
      { status: 402 }
    );
    expect(isCreditExhaustedError(err)).toBe(true);
  });

  it("recognizes OpenRouter 402 insufficient credits", () => {
    const err = Object.assign(new Error("Insufficient credits"), { status: 402 });
    expect(isCreditExhaustedError(err)).toBe(true);
  });

  it("recognizes Anthropic credit-balance-too-low (HTTP 400)", () => {
    expect(
      isCreditExhaustedError(
        new Error(
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."
        )
      )
    ).toBe(true);
  });

  it("recognizes DeepSeek's 402 Insufficient Balance", () => {
    const err = Object.assign(new Error("402 Insufficient Balance"), { status: 402 });
    expect(isCreditExhaustedError(err)).toBe(true);
  });

  it("recognizes DeepSeek's balance error after classifyProviderError drops the status", () => {
    // classifyProviderError rebuilds the error as a PermanentJobError carrying
    // only the message, so neither `status` nor `cause` survives to the test.
    expect(
      isCreditExhaustedError(
        new Error("Provider DEEPSEEK failed for TextGenerationTask: 402 Insufficient Balance")
      )
    ).toBe(true);
  });

  it("recognizes a bare Insufficient Balance message with no status anywhere", () => {
    expect(isCreditExhaustedError(new Error("Insufficient Balance"))).toBe(true);
  });

  it("recognizes an insufficient_balance error code", () => {
    expect(
      isCreditExhaustedError({
        error: { message: "unavailable", type: "unknown_error", code: "insufficient_balance" },
      })
    ).toBe(true);
  });

  it("recognizes a 402 on a diagnostics line below the summary line", () => {
    expect(
      isCreditExhaustedError(
        new Error("Provider DEEPSEEK failed for ToolCallingTask\n\n402 Insufficient Balance")
      )
    ).toBe(true);
  });

  it("recognizes OpenAI insufficient_quota even when the status is 429", () => {
    const err = Object.assign(
      new Error("You exceeded your current quota, please check your plan and billing details."),
      { status: 429, code: "insufficient_quota" }
    );
    expect(isCreditExhaustedError(err)).toBe(true);
  });

  it("recognizes a classifyProviderError-wrapped 'no credits remaining' message", () => {
    expect(
      isCreditExhaustedError(new Error("Provider OPENAI failed: 400 no credits remaining"))
    ).toBe(true);
  });

  it("recognizes Payment Required without a numeric status", () => {
    expect(isCreditExhaustedError(new Error("Payment Required"))).toBe(true);
  });

  it("recognizes HTTP 402 in the message when status is not a field", () => {
    expect(isCreditExhaustedError(new Error("HF_INFERENCE lookup failed (HTTP 402)"))).toBe(true);
  });

  it("walks error.cause so an SDK wrapper still matches", () => {
    const cause = Object.assign(new Error("not enough credits"), { status: 402 });
    expect(isCreditExhaustedError(new Error("HF inference failed", { cause }))).toBe(true);
  });

  it("does not treat a TPM/RPM rate limit as credit exhaustion", () => {
    const err = Object.assign(new Error("Rate limit exceeded. Please retry later."), {
      status: 429,
      code: "rate_limit_exceeded",
    });
    expect(isCreditExhaustedError(err)).toBe(false);
  });

  it("does not match backpressure 'credit' wording", () => {
    expect(
      isCreditExhaustedError(
        new Error("Passthrough edge gate stalled for 1000ms without pull or credit progress.")
      )
    ).toBe(false);
  });

  it("does not match scoring 'partial credit' wording", () => {
    expect(
      isCreditExhaustedError(
        new Error("gives partial credit when the candidate finds only some roles")
      )
    ).toBe(false);
  });

  it("does not match a generic 400", () => {
    const err = Object.assign(new Error("invalid_request: temperature is not supported"), {
      status: 400,
    });
    expect(isCreditExhaustedError(err)).toBe(false);
  });

  it("does not treat a bare 402 in unrelated prose as credit exhaustion", () => {
    expect(isCreditExhaustedError(new Error("Item 402(c) compensation table"))).toBe(false);
    expect(isCreditExhaustedError(new Error("Sequence length 402 exceeds the limit"))).toBe(false);
    expect(isCreditExhaustedError(new Error("model deepseek-402 not found"))).toBe(false);
  });
});

describe("creditExhaustionSkipsTest", () => {
  it("skips on CI", () => {
    expect(creditExhaustionSkipsTest({ CI: "true" })).toBe(true);
    expect(creditExhaustionSkipsTest({ GITHUB_ACTIONS: "true" })).toBe(true);
  });

  it("fails locally, so the developer who can top the account up sees it", () => {
    expect(creditExhaustionSkipsTest({})).toBe(false);
    expect(creditExhaustionSkipsTest({ CI: "" })).toBe(false);
    expect(creditExhaustionSkipsTest({ CI: "false" })).toBe(false);
  });

  it("honors the override in both directions", () => {
    expect(creditExhaustionSkipsTest({ WORKGLOW_CREDIT_EXHAUSTED_SKIP: "1" })).toBe(true);
    expect(creditExhaustionSkipsTest({ CI: "true", WORKGLOW_CREDIT_EXHAUSTED_SKIP: "0" })).toBe(
      false
    );
  });

  it("reads process.env by default", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("WORKGLOW_CREDIT_EXHAUSTED_SKIP", "");
    expect(creditExhaustionSkipsTest()).toBe(true);
  });
});

describe("runWithCreditSkip", () => {
  it("calls skip instead of rethrowing a credit error on CI", async () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("WORKGLOW_CREDIT_EXHAUSTED_SKIP", "");
    const notes: string[] = [];
    await runWithCreditSkip({ skip: (note?: string) => notes.push(note ?? "") }, async () => {
      throw Object.assign(new Error("Insufficient credits"), { status: 402 });
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/credits/i);
  });

  it("rethrows a credit error locally instead of skipping", async () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("WORKGLOW_CREDIT_EXHAUSTED_SKIP", "");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const notes: string[] = [];
    await expect(
      runWithCreditSkip({ skip: (note?: string) => notes.push(note ?? "") }, async () => {
        throw Object.assign(new Error("Insufficient Balance"), { status: 402 });
      })
    ).rejects.toThrow("Insufficient Balance");
    expect(notes).toHaveLength(0);
  });

  it("rethrows a non-credit error", async () => {
    vi.stubEnv("CI", "true");
    await expect(
      runWithCreditSkip({ skip: () => undefined }, async () => {
        throw new Error("model not found");
      })
    ).rejects.toThrow("model not found");
  });

  it("returns the body's result when nothing is thrown", async () => {
    const result = await runWithCreditSkip({ skip: () => undefined }, async () => 7);
    expect(result).toBe(7);
  });
});

describe("wrapTestBodyForCreditSkip", () => {
  const deepSeekBillingError = (): Error =>
    new Error("Provider DEEPSEEK failed for TextGenerationTask: 402 Insufficient Balance");

  it("skips the test body's DeepSeek billing failure on CI", async () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("WORKGLOW_CREDIT_EXHAUSTED_SKIP", "");
    const notes: string[] = [];
    const body = wrapTestBodyForCreditSkip(() => {
      throw deepSeekBillingError();
    });
    await (body as (ctx: unknown) => Promise<unknown>)({
      skip: (note?: string) => notes.push(note ?? ""),
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/out of credits/i);
  });

  it("fails the test body locally", async () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("WORKGLOW_CREDIT_EXHAUSTED_SKIP", "");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = wrapTestBodyForCreditSkip(() => {
      throw deepSeekBillingError();
    });
    await expect(
      (body as (ctx: unknown) => Promise<unknown>)({ skip: () => undefined })
    ).rejects.toThrow(/Insufficient Balance/);
  });
});

/**
 * The two halves have to agree. `classifyProviderError` rebuilds the provider's
 * error as a job error carrying the message and nothing else — no `status`, no
 * `cause` — so a detector that only reads `err.status` sees a plain 402 as an
 * unknown permanent failure. This is what a live DeepSeek billing failure
 * actually looks like by the time a test body catches it.
 */
describe("a provider billing error survives classifyProviderError", () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    // OpenAI-SDK shape (DeepSeek, OpenRouter, xAI): `${status} ${message}`.
    ["DeepSeek", Object.assign(new Error("402 Insufficient Balance"), { status: 402 })],
    [
      "OpenRouter",
      Object.assign(new Error("402 Insufficient credits"), { status: 402, code: "402" }),
    ],
    [
      "Anthropic",
      Object.assign(new Error("400 Your credit balance is too low to access the Anthropic API."), {
        status: 400,
      }),
    ],
    [
      "OpenAI",
      Object.assign(new Error("429 You exceeded your current quota"), {
        status: 429,
        code: "insufficient_quota",
      }),
    ],
    [
      "HuggingFace Inference",
      Object.assign(new Error("You have depleted your monthly included credits."), { status: 402 }),
    ],
  ];

  for (const [provider, raw] of cases) {
    it(`still reads as credit exhaustion for ${provider}`, () => {
      const classified = classifyProviderError(raw, "TextGenerationTask", provider.toUpperCase());
      expect(isCreditExhaustedError(classified)).toBe(true);
    });
  }

  it("does not read a classified rate limit as credit exhaustion", () => {
    const classified = classifyProviderError(
      Object.assign(new Error("429 Rate limit reached, retry after 5"), {
        status: 429,
        code: "rate_limit_exceeded",
      }),
      "TextGenerationTask",
      "OPENAI"
    );
    expect(isCreditExhaustedError(classified)).toBe(false);
  });
});
