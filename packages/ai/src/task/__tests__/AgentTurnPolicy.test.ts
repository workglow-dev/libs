/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { AgentTurnBudget } from "../AgentTurnBudget";
import type { AgentFollowUp, AgentTurnPolicyOptions } from "../AgentTurnPolicy";
import { AgentTurnPolicy, MAX_SUBMISSION_REJECTIONS, timeLeftNotice } from "../AgentTurnPolicy";
import type { AgentToolRecord } from "../AgentTurnRecord";
import { AGENT_SUBMIT_TOOL_NAME } from "../AgentTurnRecord";
import type { ChatMessage, ContentBlockToolResult } from "../ChatMessage";
import { ToolCallError } from "../ToolCallingUtils";

const SCHEMA = {
  type: "object",
  properties: { trust: { type: "integer" } },
  required: ["trust"],
} as const;

function policy(options: Partial<AgentTurnPolicyOptions> = {}): AgentTurnPolicy {
  return new AgentTurnPolicy({
    maxRounds: 8,
    outputSchema: undefined,
    checkSubmission: undefined,
    reviewPrompt: undefined,
    announceTimeLeft: false,
    turnSoFar: () => ({ messages: [], steps: [] }),
    ...options,
  });
}

function unlimited(): AgentTurnBudget {
  return new AgentTurnBudget(
    { maxInputTokens: undefined, maxCostUsd: undefined, maxDurationMs: undefined },
    undefined
  );
}

function textOf(message: ChatMessage | undefined): string {
  const block = message?.content[0];
  return block?.type === "text" ? block.text : "";
}

/** Runs the submit tool's `execute` as the loop would, returning its result or the error it threw. */
async function submit(turn: AgentTurnPolicy, value: unknown): Promise<string | ToolCallError> {
  try {
    const context = {
      toolUseId: "s1",
      signal: new AbortController().signal,
      deadline: undefined,
    };
    return String(await turn.submitTool!.execute!(value as Record<string, unknown>, context));
  } catch (error) {
    if (error instanceof ToolCallError) return error;
    throw error;
  }
}

describe("AgentTurnPolicy", () => {
  describe("submission", () => {
    it("adds no submit tool without a schema, or with an empty one", () => {
      expect(policy().submitTool).toBeUndefined();
      expect(policy({ outputSchema: {} }).submitTool).toBeUndefined();
    });

    it("records an answer the check accepts", async () => {
      const turn = policy({ outputSchema: SCHEMA });
      expect(turn.submitTool?.name).toBe(AGENT_SUBMIT_TOOL_NAME);
      expect(turn.submitted).toBeUndefined();
      expect(await submit(turn, { trust: 230 })).toBe("Answer recorded.");
      expect(turn.submitted).toEqual({ value: { trust: 230 } });
    });

    it("sends an answer back with the check's reason, then accepts after the limit", async () => {
      const seen: number[] = [];
      const turn = policy({
        outputSchema: SCHEMA,
        checkSubmission: (_answer, context) => {
          seen.push(context.rejections);
          return "The trust is missing a figure.";
        },
      });
      for (let i = 0; i < MAX_SUBMISSION_REJECTIONS; i++) {
        const result = await submit(turn, { trust: 0 });
        expect(result).toBeInstanceOf(ToolCallError);
        expect(String((result as ToolCallError).message)).toContain("missing a figure");
        expect(turn.submitted).toBeUndefined();
      }
      expect(await submit(turn, { trust: 0 })).toBe("Answer recorded.");
      expect(turn.submissionRejections).toHaveLength(MAX_SUBMISSION_REJECTIONS);
      expect(seen).toEqual([0, 1]);
    });

    it("hands the check the turn as it stands when the model submits", async () => {
      const messages: ChatMessage[] = [];
      let seen = -1;
      const turn = policy({
        outputSchema: SCHEMA,
        checkSubmission: (_answer, context) => {
          seen = context.messages.length;
          return undefined;
        },
        turnSoFar: () => ({ messages, steps: [] }),
      });
      messages.push({ role: "user", content: [{ type: "text", text: "?" }] });
      await submit(turn, { trust: 1 });
      expect(seen).toBe(1);
    });
  });

  describe("followUp", () => {
    const sent = (next: AgentFollowUp): string => {
      if (next.kind !== "send") throw new Error(`expected a message, got ${next.stopReason}`);
      return textOf(next.message);
    };
    const ANSWERED: AgentFollowUp = { kind: "end", stopReason: "answered" };
    const BUDGET: AgentFollowUp = { kind: "end", stopReason: "budget" };

    function tokenBudget(charged: Parameters<AgentTurnBudget["record"]>[0]): AgentTurnBudget {
      const budget = new AgentTurnBudget(
        { maxInputTokens: 1_000, maxCostUsd: undefined, maxDurationMs: undefined },
        undefined
      );
      budget.record(charged, undefined);
      return budget;
    }
    const spentUsage = {
      input: 2_000,
      cached: 0,
      output: 1,
      cacheWrite: 0,
      reasoning: undefined,
      total: undefined,
      extra: undefined,
    };

    it("asks for a review once, the first time the model answers", () => {
      const turn = policy({ reviewPrompt: "Check it." });
      expect(sent(turn.followUp(0, unlimited()))).toBe("Check it.");
      expect(turn.followUp(1, unlimited())).toEqual(ANSWERED);
    });

    it("sends no review with no round, budget or time left to act on it, and keeps the answer", () => {
      expect(policy({ reviewPrompt: "Check it.", maxRounds: 1 }).followUp(0, unlimited())).toEqual(
        ANSWERED
      );
      expect(policy({ reviewPrompt: "Check it." }).followUp(0, tokenBudget(spentUsage))).toEqual(
        ANSWERED
      );
      // A round it could not measure stops the loop, so it rules out the review too.
      expect(policy({ reviewPrompt: "Check it." }).followUp(0, tokenBudget(undefined))).toEqual(
        ANSWERED
      );
      const late = new AgentTurnBudget(
        { maxInputTokens: undefined, maxCostUsd: undefined, maxDurationMs: 1 },
        undefined,
        0
      );
      expect(policy({ reviewPrompt: "Check it." }).followUp(0, late)).toEqual(ANSWERED);
    });

    it("leaves the review to checkSubmission on a turn with an outputSchema", () => {
      const turn = policy({ reviewPrompt: "Check it.", outputSchema: SCHEMA });
      expect(sent(turn.followUp(0, unlimited()))).toContain(AGENT_SUBMIT_TOOL_NAME);
    });

    it("reminds a model to submit twice, then lets the turn end answered", () => {
      const turn = policy({ outputSchema: SCHEMA });
      expect(sent(turn.followUp(0, unlimited()))).toContain(AGENT_SUBMIT_TOOL_NAME);
      expect(sent(turn.followUp(1, unlimited()))).toContain(AGENT_SUBMIT_TOOL_NAME);
      expect(turn.followUp(2, unlimited())).toEqual(ANSWERED);
    });

    it("sends no reminder on the last round, and ends the turn answered", () => {
      const turn = policy({ outputSchema: SCHEMA, maxRounds: 2 });
      expect(sent(turn.followUp(0, unlimited()))).toContain(AGENT_SUBMIT_TOOL_NAME);
      expect(turn.followUp(1, unlimited())).toEqual(ANSWERED);
    });

    it("sends no reminder once the turn's time is gone, and ends it budget", () => {
      const late = new AgentTurnBudget(
        { maxInputTokens: undefined, maxCostUsd: undefined, maxDurationMs: 1 },
        undefined,
        0
      );
      expect(policy({ outputSchema: SCHEMA }).followUp(0, late)).toEqual(BUDGET);
    });

    it("still reminds after a round it could not measure", () => {
      const turn = policy({ outputSchema: SCHEMA });
      expect(sent(turn.followUp(0, tokenBudget(undefined)))).toContain(AGENT_SUBMIT_TOOL_NAME);
    });

    it("ends budget, sending no reminder, once the measured spend reaches a cap", () => {
      expect(policy({ outputSchema: SCHEMA }).followUp(0, tokenBudget(spentUsage))).toEqual(BUDGET);
    });

    it("ends the turn answered when it has nothing to ask", () => {
      expect(policy().followUp(0, unlimited())).toEqual(ANSWERED);
      expect(policy().followUp(0, tokenBudget(spentUsage))).toEqual(ANSWERED);
    });
  });

  describe("announceTimeLeft", () => {
    const record = (id: string, chars: number): AgentToolRecord => ({
      id,
      name: "echo",
      isError: false,
      chars,
      durationMs: 1,
    });
    const result = (
      id: string,
      content: ContentBlockToolResult["content"]
    ): ContentBlockToolResult => ({
      type: "tool_result",
      tool_use_id: id,
      content,
      is_error: undefined,
    });

    it("joins the time left onto the last result's text and counts it", () => {
      const results = [
        result("a", [{ type: "text", text: "one" }]),
        result("b", [{ type: "text", text: "two" }]),
      ];
      const records = [record("a", 3), record("b", 3)];
      policy({ announceTimeLeft: true }).announceTimeLeft(results, records, 95_000, 0);
      const notice = timeLeftNotice(95_000);
      expect(notice).toBe("\n\n[Time left: 1m 35s]");
      expect(results[0]!.content).toEqual([{ type: "text", text: "one" }]);
      expect(results[1]!.content).toEqual([{ type: "text", text: `two${notice}` }]);
      expect(records[1]!.chars).toBe(3 + notice.length);
    });

    it("leads a result of images alone with the notice", () => {
      const image = { type: "image", mimeType: "image/png", data: "AA==" } as const;
      const results = [result("a", [image])];
      policy({ announceTimeLeft: true }).announceTimeLeft(results, [record("a", 0)], 5_400, 0);
      expect(results[0]!.content).toEqual([{ type: "text", text: "\n\n[Time left: 5s]" }, image]);
    });

    it("says nothing unless asked, or without a deadline", () => {
      const results = [result("a", [{ type: "text", text: "one" }])];
      policy().announceTimeLeft(results, [record("a", 3)], 10_000, 0);
      policy({ announceTimeLeft: true }).announceTimeLeft(results, [record("a", 3)], undefined, 0);
      expect(results[0]!.content).toEqual([{ type: "text", text: "one" }]);
    });
  });
});
