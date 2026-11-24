/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { getModelName } from "./OpenAI_Client";
import type { OpenAiModelConfig } from "./OpenAI_ModelSchema";
import { resolveOpenAiProfile } from "./OpenAI_ModelProfiles";

/** Whether the model answers `stream: true` on the Responses API. */
export function openAiModelStreams(modelName: string): boolean {
  const { profile } = resolveOpenAiProfile(modelName);
  return profile.kind !== "chat" || profile.streams;
}

/**
 * Open a Responses call as a stream of Responses events, whether or not the
 * model streams.
 *
 * A model that does not stream (gpt-5.5-pro) answers `stream: true` with a 400,
 * so it is sent one ordinary request and the finished response is replayed as
 * the events a stream would have carried. Every run-fn then reads one shape,
 * and the reply arrives in one piece instead of failing.
 */
export async function createResponsesEventStream(
  client: any,
  params: Record<string, unknown>,
  model: OpenAiModelConfig | undefined,
  signal: AbortSignal | undefined
): Promise<AsyncIterable<unknown>> {
  const modelName = typeof params.model === "string" ? params.model : getModelName(model);
  if (openAiModelStreams(modelName)) {
    return (await client.responses.create(
      { ...params, stream: true },
      { signal }
    )) as AsyncIterable<unknown>;
  }
  // The SDK's 10-minute default timeout covers a non-streaming call until the
  // whole response is ready, and it retries a timeout: a pro run that thinks
  // past it would be abandoned and billed again up to twice. The run's signal
  // still bounds the call.
  const response = await client.responses.create(
    { ...params, stream: false },
    { signal, timeout: NON_STREAMING_TIMEOUT_MS }
  );
  return responseAsEvents(response);
}

/** How long a non-streaming Responses call may take before the SDK gives up on it. */
const NON_STREAMING_TIMEOUT_MS = 60 * 60_000;

/**
 * The stream events a finished Responses `response` stands for: each output
 * item's text, refusal and reasoning summary as one delta, each item as
 * `output_item.done` (which is what carries a function call and the turn
 * replayed next round), then the terminal event with the usage.
 */
export async function* responseAsEvents(response: unknown): AsyncGenerator<unknown> {
  const body = (response ?? {}) as { output?: unknown; status?: unknown; id?: unknown };
  const output = Array.isArray(body.output) ? body.output : [];
  for (const [index, raw] of output.entries()) {
    const item = (raw ?? {}) as {
      id?: unknown;
      type?: unknown;
      content?: unknown;
      summary?: unknown;
    };
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const [contentIndex, part] of item.content.entries()) {
        const p = (part ?? {}) as { type?: unknown; text?: unknown; refusal?: unknown };
        if (p.type === "output_text" && typeof p.text === "string" && p.text !== "") {
          yield {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: index,
            content_index: contentIndex,
            delta: p.text,
          };
        } else if (p.type === "refusal" && typeof p.refusal === "string" && p.refusal !== "") {
          yield {
            type: "response.refusal.delta",
            item_id: item.id,
            output_index: index,
            content_index: contentIndex,
            delta: p.refusal,
          };
        }
      }
    } else if (item.type === "reasoning" && Array.isArray(item.summary)) {
      for (const [summaryIndex, part] of item.summary.entries()) {
        const text = (part as { text?: unknown } | null)?.text;
        if (typeof text === "string" && text !== "") {
          yield {
            type: "response.reasoning_summary_text.delta",
            item_id: item.id,
            output_index: index,
            summary_index: summaryIndex,
            delta: text,
          };
        }
      }
    }
    yield { type: "response.output_item.done", output_index: index, item: raw };
  }
  const terminal =
    body.status === "incomplete"
      ? "response.incomplete"
      : body.status === "failed"
        ? "response.failed"
        : "response.completed";
  yield { type: terminal, response };
}
