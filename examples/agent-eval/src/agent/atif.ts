/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentStep, ChatMessage, ContentBlock } from "@workglow/ai";
import type { AgentRunSummary } from "./runSummary";

/**
 * A run as an ATIF trajectory (Harbor's Agent Trajectory Interchange Format),
 * so `harbor view` draws a workglow trial the way it draws opencode's and
 * pi's. Only the fields Harbor reads are filled.
 */
export interface AtifTrajectory {
  readonly schema_version: "ATIF-v1.8";
  readonly session_id: string;
  readonly agent: { readonly name: string; readonly version: string; readonly model_name: string };
  readonly steps: readonly AtifStep[];
  readonly final_metrics: {
    readonly total_prompt_tokens: number;
    readonly total_completion_tokens: number;
    readonly total_cached_tokens: number;
    readonly total_cost_usd: number | null;
    readonly total_steps: number;
  };
}

interface AtifStep {
  readonly step_id: number;
  readonly timestamp?: string | undefined;
  readonly source: "user" | "agent";
  readonly message: string;
  readonly model_name?: string | undefined;
  readonly tool_calls?:
    | ReadonlyArray<{ tool_call_id: string; function_name: string; arguments: unknown }>
    | undefined;
  readonly observation?:
    | { readonly results: ReadonlyArray<{ source_call_id: string; content: string }> }
    | undefined;
  readonly metrics?:
    | {
        readonly prompt_tokens: number | null;
        readonly completion_tokens: number | null;
        readonly cached_tokens: number | null;
        readonly cost_usd: number | null;
      }
    | undefined;
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function resultText(block: Extract<ContentBlock, { type: "tool_result" }>): string {
  return block.content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("");
}

export function toAtifTrajectory(
  sessionId: string,
  version: string,
  messages: readonly ChatMessage[],
  steps: readonly AgentStep[],
  summary: AgentRunSummary
): AtifTrajectory {
  const out: AtifStep[] = [];
  let round = 0;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "user") {
      out.push({ step_id: out.length + 1, source: "user", message: textOf(message.content) });
      continue;
    }
    if (message.role !== "assistant") continue;
    // A round that produced neither text nor a call left no assistant message.
    while (round < steps.length && steps[round]!.tools.length === 0 && steps[round]!.text === "") {
      round++;
    }
    const step = steps[round++];
    const calls = message.content.filter(
      (block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use"
    );
    const next = messages[i + 1];
    const results =
      next?.role === "tool"
        ? next.content
            .filter(
              (block): block is Extract<ContentBlock, { type: "tool_result" }> =>
                block.type === "tool_result"
            )
            .map((block) => ({ source_call_id: block.tool_use_id, content: resultText(block) }))
        : [];
    const usage = step?.usage;
    out.push({
      step_id: out.length + 1,
      timestamp: step?.startedAt,
      source: "agent",
      message: textOf(message.content),
      model_name: summary.model,
      ...(calls.length > 0
        ? {
            tool_calls: calls.map((call) => ({
              tool_call_id: call.id,
              function_name: call.name,
              arguments: call.input,
            })),
          }
        : {}),
      ...(results.length > 0 ? { observation: { results } } : {}),
      ...(usage
        ? {
            metrics: {
              prompt_tokens: (usage.input ?? 0) + (usage.cached ?? 0) + (usage.cacheWrite ?? 0),
              completion_tokens: usage.output ?? null,
              cached_tokens: usage.cached ?? null,
              cost_usd: step?.costUsd ?? null,
            },
          }
        : {}),
    });
  }
  return {
    schema_version: "ATIF-v1.8",
    session_id: sessionId,
    agent: { name: "workglow", version, model_name: summary.model },
    steps: out,
    final_metrics: {
      total_prompt_tokens: summary.usage.promptTokens,
      total_completion_tokens: summary.usage.outputTokens,
      total_cached_tokens: summary.usage.cacheReadTokens,
      total_cost_usd: summary.costUsd ?? null,
      total_steps: out.length,
    },
  };
}
