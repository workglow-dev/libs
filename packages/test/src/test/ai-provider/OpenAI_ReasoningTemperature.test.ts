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
 *   temperature: 0.4                            -> 400 Unsupported parameter
 *   reasoning: {effort:"none"}                  -> 200
 *   reasoning: {effort:"low"}, temperature: 0.4 -> 400 Unsupported parameter
 *   reasoning: {effort:"low"}                   -> 200
 * A reasoning model runs at its class default effort unless configured
 * otherwise, and the temperature only survives an effort of `none`.
 */
describe("finalizeResponsesRequest on a reasoning model", () => {
  const luna = (extra: Record<string, unknown> = {}, reasoning?: unknown) =>
    ({
      provider_config: { model_name: "gpt-5.6-luna", ...(reasoning ? { reasoning } : {}) },
      ...extra,
    }) as never;

  it("sends the class default effort when none is configured", () => {
    const params = finalizeResponsesRequest(luna(), { model: "gpt-5.6-luna" });
    expect(params.reasoning).toEqual({ effort: "medium" });
  });

  it("sends the default and drops a pinned temperature rather than turning reasoning off", () => {
    const params = finalizeResponsesRequest(luna(), { model: "gpt-5.6-luna", temperature: 0.7 });
    expect(params.reasoning).toEqual({ effort: "medium" });
    expect(params.temperature).toBeUndefined();
  });

  it("maps model.effort over the class default", () => {
    const params = finalizeResponsesRequest(luna({ effort: "extra" }), { model: "gpt-5.6-luna" });
    expect(params.reasoning).toEqual({ effort: "xhigh" });
  });

  it("never overrides an explicitly configured reasoning effort", () => {
    const params = finalizeResponsesRequest(luna({ effort: "ultra" }, { effort: "high" }), {
      model: "gpt-5.6-luna",
      temperature: 0,
    });
    expect(params.reasoning).toEqual({ effort: "high" });
    expect(params.temperature).toBeUndefined();
  });

  it("keeps the temperature alongside an effort of none", () => {
    for (const model of [luna({ effort: "none" }), luna({}, { effort: "none" })]) {
      const params = finalizeResponsesRequest(model, { model: "gpt-5.6-luna", temperature: 0.2 });
      expect(params).toMatchObject({ reasoning: { effort: "none" }, temperature: 0.2 });
    }
  });

  it("sends no default when the record's effort_options leave it out", () => {
    const params = finalizeResponsesRequest(luna({ effort_options: ["low", "high"] }), {
      model: "gpt-5.6-luna",
    });
    expect("reasoning" in params).toBe(false);
  });
});

/**
 * gpt-6 always reasons. Verified live against `gpt-6-astra`:
 *   temperature: 0.4                            -> 400 Unsupported parameter
 *   reasoning: {effort:"none"}                  -> 400 Supported values are: 'low' ... 'max'
 *   reasoning: {effort:"low"}, temperature: 0.4 -> 400 Unsupported parameter
 *   reasoning: {effort:"low"}                   -> 200
 */
describe("finalizeResponsesRequest on a model that cannot turn reasoning off", () => {
  const astra = (extra: Record<string, unknown> = {}) =>
    ({ provider_config: { model_name: "gpt-6-astra" }, ...extra }) as never;

  it("sends the default effort and drops a pinned temperature", () => {
    const params = finalizeResponsesRequest(astra(), { model: "gpt-6-astra", temperature: 0.4 });
    expect(params.reasoning).toEqual({ effort: "medium" });
    expect(params.temperature).toBeUndefined();
  });

  it("does not map model.effort none onto the request", () => {
    const params = finalizeResponsesRequest(astra({ effort: "none" }), { model: "gpt-6-astra" });
    expect(params.reasoning).toEqual({ effort: "medium" });
  });

  it("never sends none, however the record asks for it", () => {
    const records = [
      astra({ effort: "none", effort_options: ["none", "low", "medium"] }),
      { provider_config: { model_name: "gpt-6-astra", reasoning: { effort: "none" } } } as never,
    ];
    for (const record of records) {
      const params = finalizeResponsesRequest(record, { model: "gpt-6-astra", temperature: 0.4 });
      expect(params.reasoning).toEqual({ effort: "medium" });
      expect(params.temperature).toBeUndefined();
    }
  });

  it("keeps the rest of a native config when dropping its none", () => {
    const params = finalizeResponsesRequest(
      {
        provider_config: { model_name: "gpt-6-astra", reasoning: { effort: "none", mode: "pro" } },
      } as never,
      { model: "gpt-6-astra" }
    );
    expect(params.reasoning).toEqual({ mode: "pro" });
  });

  it("maps a supported effort", () => {
    const params = finalizeResponsesRequest(astra({ effort: "high" }), { model: "gpt-6-astra" });
    expect(params.reasoning).toEqual({ effort: "high" });
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
