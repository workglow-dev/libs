/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly } from "@workglow/openai/ai";
import { describe, expect, it } from "vitest";
const { finalizeResponsesRequest } = _testOnly;

/**
 * `temperature` and `reasoning` are not independently selectable on the OpenAI
 * reasoning families. Verified live against `gpt-5.6-luna`:
 *   temperature: 0                              -> 400 Unsupported parameter
 *   reasoning: {effort:"none"}                  -> 200
 *   reasoning: {effort:"none"}, temperature: 0  -> 200
 * So a request that pins a temperature must turn reasoning off to be accepted.
 */
describe("finalizeResponsesRequest reasoning/temperature coupling", () => {
  const model = (reasoning?: unknown) =>
    ({
      provider_config: { model_name: "gpt-5.6-luna", ...(reasoning ? { reasoning } : {}) },
    }) as never;

  it("forces reasoning off when a temperature is pinned and none is configured", () => {
    const params = finalizeResponsesRequest(model(), { model: "gpt-5.6-luna", temperature: 0 });
    expect(params.reasoning).toEqual({ effort: "none" });
  });

  it("does so for any pinned temperature, not just zero", () => {
    const params = finalizeResponsesRequest(model(), { model: "gpt-5.6-luna", temperature: 0.7 });
    expect(params.reasoning).toEqual({ effort: "none" });
  });

  it("sends no reasoning field when no temperature is pinned", () => {
    const params = finalizeResponsesRequest(model(), { model: "gpt-5.6-luna" });
    expect(params.reasoning).toBeUndefined();
  });

  it("never overrides an explicitly configured reasoning effort", () => {
    const params = finalizeResponsesRequest(model({ effort: "high" }), {
      model: "gpt-5.6-luna",
      temperature: 0,
    });
    expect(params.reasoning).toEqual({ effort: "high" });
  });

  it("honours model.effort over the temperature auto-none default", () => {
    const params = finalizeResponsesRequest(
      { provider_config: { model_name: "gpt-5.6-luna" }, effort: "medium" } as never,
      { model: "gpt-5.6-luna", temperature: 0 }
    );
    expect(params.reasoning).toEqual({ effort: "medium" });
  });

  it("drops the temperature when an effort turns reasoning on", () => {
    const params = finalizeResponsesRequest(
      { provider_config: { model_name: "gpt-5.6-luna" }, effort: "medium" } as never,
      { model: "gpt-5.6-luna", temperature: 0 }
    );
    expect(params.temperature).toBeUndefined();
  });

  it("keeps the temperature alongside an explicit effort of none", () => {
    const params = finalizeResponsesRequest(model({ effort: "none" }), {
      model: "gpt-5.6-luna",
      temperature: 0.2,
    });
    expect(params).toMatchObject({ reasoning: { effort: "none" }, temperature: 0.2 });
  });
});

/**
 * gpt-6 always reasons. Verified live against `gpt-6-astra`:
 *   temperature: 0.4                            -> 400 Unsupported parameter
 *   reasoning: {effort:"none"}                  -> 400 Supported values are: 'low' ... 'max'
 *   reasoning: {effort:"low"}, temperature: 0.4 -> 400 Unsupported parameter
 *   reasoning: {effort:"low"}                   -> 200
 * So the temperature cannot be bought by turning reasoning off; it is dropped.
 */
describe("finalizeResponsesRequest on a model that cannot turn reasoning off", () => {
  const astra = (extra: Record<string, unknown> = {}) =>
    ({ provider_config: { model_name: "gpt-6-astra" }, ...extra }) as never;

  it("sends no effort of none and drops the pinned temperature", () => {
    const params = finalizeResponsesRequest(astra(), { model: "gpt-6-astra", temperature: 0.4 });
    expect(params.reasoning).toBeUndefined();
    expect("reasoning" in params).toBe(false);
    expect(params.temperature).toBeUndefined();
  });

  it("does not map model.effort none onto the request", () => {
    const params = finalizeResponsesRequest(astra({ effort: "none" }), { model: "gpt-6-astra" });
    expect(params.reasoning).toBeUndefined();
  });

  it("maps a supported effort and drops the temperature", () => {
    const params = finalizeResponsesRequest(astra({ effort: "high" }), {
      model: "gpt-6-astra",
      temperature: 0,
    });
    expect(params.reasoning).toEqual({ effort: "high" });
    expect(params.temperature).toBeUndefined();
  });
});

/**
 * Verified live against `gpt-4o`: `temperature: 0.4` -> 200, any
 * `reasoning.effort` (`"none"` included) -> 400 Unsupported parameter.
 */
describe("finalizeResponsesRequest on a model that takes no reasoning", () => {
  it("keeps the temperature and sends no reasoning field", () => {
    const params = finalizeResponsesRequest(
      { provider_config: { model_name: "gpt-4o" } } as never,
      { model: "gpt-4o", temperature: 0.4 }
    );
    expect("reasoning" in params).toBe(false);
    expect(params.temperature).toBe(0.4);
  });
});
