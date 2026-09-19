/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AiProviderRunFn, StreamEvent, SystemOneTaskOutput } from "@workglow/ai";
import { _testOnly, TYPESAFEAI } from "@workglow/typesafeai/ai";
import { _testOnly as runtimeTestOnly } from "@workglow/typesafeai/ai-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { TYPESAFEAI_RUN_FNS, setTypeSafeAiClientForTests } = _testOnly;

function runFnFor(capability: string): AiProviderRunFn {
  const registration = TYPESAFEAI_RUN_FNS.find(({ serves }) =>
    (serves as readonly string[]).includes(capability)
  );
  expect(registration, `no run-fn serves ${capability}`).toBeDefined();
  return registration!.runFn as AiProviderRunFn;
}

const modelConfig = (modelName = "jev-latest") =>
  ({
    model_id: modelName,
    title: modelName,
    description: "",
    provider: TYPESAFEAI,
    provider_config: { model_name: modelName, api_key: "test-key" },
    capabilities: ["judgment.systemone"],
    metadata: {},
  }) as never;

interface Recorded {
  readonly state: unknown;
  readonly questions: Record<string, unknown>;
  readonly model?: string;
}

function installClient(respond: (request: Recorded) => unknown, sink: Recorded[]): void {
  const client = {
    systemOne: async (request: Recorded) => {
      sink.push(request);
      return respond(request);
    },
    models: { list: async () => [] },
  };
  setTypeSafeAiClientForTests(client as never);
  runtimeTestOnly.setTypeSafeAiClientForTests?.(client as never);
}

describe("TypeSafeAi_SystemOne", () => {
  let requests: Recorded[];

  beforeEach(() => {
    requests = [];
  });

  afterEach(() => {
    setTypeSafeAiClientForTests(undefined);
    runtimeTestOnly.setTypeSafeAiClientForTests?.(undefined);
  });

  it("forwards the question map verbatim under the caller's own keys", async () => {
    installClient(
      () => ({
        model: "jev-1.13.0",
        answers: { is_urgent: { type: "noul", noul: 0.92 } },
        usage: { input_tokens: 312, output_tokens: 48 },
      }),
      requests
    );

    const model = modelConfig();
    const questions = {
      is_urgent: {
        type: "noul",
        instructions: "Does this convey urgency?",
        criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" },
      },
    };
    await runFnFor("judgment.systemone")(
      { model, state: "Payouts have been failing for 3 days.", questions },
      model,
      new AbortController().signal,
      () => {}
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.state).toBe("Payouts have been failing for 3 days.");
    expect(requests[0]!.questions).toEqual(questions);
    expect(requests[0]!.model).toBe("jev-latest");
  });

  it("returns every answer under the key its question was asked under", async () => {
    installClient(
      () => ({
        model: "jev-1.13.0",
        answers: {
          urgent: { type: "noul", noul: 0.92 },
          department: {
            type: "choice",
            choice: "technical",
            probabilities: { billing: 0.08, technical: 0.85, sales: 0.07 },
            confidence: 0.82,
          },
          frustration: {
            type: "score",
            score: 1.6,
            legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
            probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
            confidence: 0.78,
          },
        },
        usage: { input_tokens: 312, output_tokens: 48 },
      }),
      requests
    );

    const model = modelConfig();
    let finish: StreamEvent<SystemOneTaskOutput> | undefined;
    await runFnFor("judgment.systemone")(
      {
        model,
        state: { ticket: "help" },
        questions: {
          urgent: { type: "noul", instructions: "urgent?" },
          department: { type: "choice", instructions: "who?", criteria: { billing: null } },
          frustration: { type: "score", instructions: "how angry?", criteria: ["a", "b"] },
        },
      },
      model,
      new AbortController().signal,
      (ev) => {
        if (ev.type === "finish") finish = ev as StreamEvent<SystemOneTaskOutput>;
      }
    );

    const answers = (finish as { data: SystemOneTaskOutput }).data.answers;
    expect(Object.keys(answers).sort()).toEqual(["department", "frustration", "urgent"]);
    expect(answers.urgent).toEqual({ type: "noul", noul: 0.92 });
    expect((answers.department as { choice: string }).choice).toBe("technical");
    expect((answers.frustration as { score: number }).score).toBe(1.6);
  });

  it("reports the token counts TypeSafe billed", async () => {
    installClient(
      () => ({
        model: "jev-1.13.0",
        answers: { q: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 312, output_tokens: 48 },
      }),
      requests
    );

    const model = modelConfig();
    let usage: unknown;
    await runFnFor("judgment.systemone")(
      { model, state: "x", questions: { q: { type: "noul", instructions: "?" } } },
      model,
      new AbortController().signal,
      (ev) => {
        if (ev.type === "finish") usage = ev.usage;
      }
    );

    // Only the two counters TypeSafe reports are numbers. Everything else stays
    // `undefined` — a `0` for an unreported counter reads as "billed nothing".
    expect(usage).toEqual({
      input: 312,
      output: 48,
      cached: undefined,
      cacheWrite: undefined,
      reasoning: undefined,
      total: undefined,
      extra: undefined,
    });
  });

  // The API rejects an empty question map, and paying a round trip to be told
  // so loses the run's own vocabulary for saying what was wrong.
  it("refuses an empty question map without reaching the wire", async () => {
    installClient(() => ({ model: "jev", answers: {}, usage: {} }), requests);

    const model = modelConfig();
    await expect(
      runFnFor("judgment.systemone")(
        { model, state: "x", questions: {} },
        model,
        new AbortController().signal,
        () => {}
      )
    ).rejects.toThrow(/at least one question/i);
    expect(requests).toHaveLength(0);
  });

  it("does not call the API once the run is aborted", async () => {
    installClient(() => ({ model: "jev", answers: {}, usage: {} }), requests);

    const controller = new AbortController();
    controller.abort();
    const model = modelConfig();
    await expect(
      runFnFor("judgment.systemone")(
        { model, state: "x", questions: { q: { type: "noul", instructions: "?" } } },
        model,
        controller.signal,
        () => {}
      )
    ).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});
